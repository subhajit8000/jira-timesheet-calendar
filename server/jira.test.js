import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getReport,
  makeRequest,
  validateRange,
  worklogVersion,
} from './jira.js';

const user = {
  accountId: 'me',
  displayName: 'Test User',
  timeZone: 'America/Los_Angeles',
};
const issue = {
  id: '100',
  key: 'TEST-1',
  fields: { summary: 'Calendar report' },
};
const worklog = (id, started, author = 'me') => ({
  id,
  started,
  author: { accountId: author },
  timeSpentSeconds: 3600,
  comment: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Work done' }] },
    ],
  },
});

test('validates calendar boundaries and limits range length', () => {
  assert.doesNotThrow(() => validateRange('2026-09-01', '2026-10-01'));
  for (const range of [
    ['2026-02-30', '2026-03-05'],
    ['bad', '2026-10-01'],
    ['2026-09-01', '2026-09-01'],
    ['2026-01-01', '2026-12-01'],
  ]) {
    assert.throws(() => validateRange(...range), /valid date range/);
  }
});

test('paginates issues and worklogs, filters author and exclusive end, converts reporting zone, deduplicates', async () => {
  const calls = [];
  const request = async (path, body) => {
    calls.push({ path, body });
    if (path === 'myself') return user;
    if (path === 'field') return [];
    if (path === 'search/jql')
      return body.nextPageToken
        ? { issues: [issue], isLast: true }
        : { issues: [issue], nextPageToken: 'next', isLast: false };
    const startAt = Number(
      new URLSearchParams(path.split('?')[1]).get('startAt'),
    );
    return startAt === 0
      ? {
          startAt: 0,
          total: 5,
          worklogs: [
            worklog('1', '2026-09-01T01:00:00.000+0000'),
            worklog('2', '2026-09-02T01:00:00.000+0000'),
          ],
        }
      : {
          startAt: 2,
          total: 5,
          worklogs: [
            worklog('3', '2026-09-02T01:00:00.000+0000', 'someone-else'),
            worklog('4', '2026-10-01T08:00:00.000+0000'),
            worklog('5', '2026-10-01T01:00:00.000+0000'),
          ],
        };
  };
  const report = await getReport({
    start: '2026-09-01',
    end: '2026-10-01',
    request,
    timeZone: 'America/Los_Angeles',
  });
  assert.deepEqual(
    report.entries.map((entry) => entry.date),
    ['2026-09-01', '2026-09-30'],
  );
  assert.equal(
    report.entries.reduce((total, entry) => total + entry.seconds, 0),
    7200,
  );
  assert.equal(report.entries[0].comment, 'Work done');
  assert.equal(report.entries[0].issueId, '100');
  assert.equal(report.entries[0].worklogId, '2');
  assert.match(report.entries[0].version, /^[a-f0-9]{64}$/);
  assert.equal(
    calls.filter((call) => call.path.startsWith('issue/')).length,
    2,
  );
  assert.match(calls[2].body.jql, /worklogAuthor = currentUser\(\)/);
  assert.equal(calls[3].body.nextPageToken, 'next');
});

test('handles empty results without claiming a failed request is empty', async () => {
  const report = await getReport({
    start: '2026-09-01',
    end: '2026-10-01',
    request: async (path) =>
      path === 'myself'
        ? user
        : path === 'field'
          ? []
          : { issues: [], isLast: true },
  });
  assert.deepEqual(report.entries, []);
  await assert.rejects(
    getReport({
      start: '2026-09-01',
      end: '2026-10-01',
      request: async () => {
        throw new Error('denied');
      },
    }),
    /denied/,
  );
});

test('fails closed for incomplete issue and worklog pagination', async () => {
  for (const brokenIssues of [true, false]) {
    await assert.rejects(
      getReport({
        start: '2026-09-01',
        end: '2026-10-01',
        request: async (path) => {
          if (path === 'myself') return user;
          if (path === 'field') return [];
          if (path === 'search/jql')
            return { issues: [issue], isLast: !brokenIssues };
          return { startAt: 0, total: 2, worklogs: [] };
        },
      }),
      /pagination/,
    );
  }
});

test('DST transition keeps both entries on the same reporting-local day', async () => {
  const report = await getReport({
    start: '2026-11-01',
    end: '2026-11-02',
    timeZone: 'America/Los_Angeles',
    request: async (path) => {
      if (path === 'myself') return user;
      if (path === 'field') return [];
      if (path === 'search/jql') return { issues: [issue], isLast: true };
      return {
        startAt: 0,
        total: 2,
        worklogs: [
          worklog('1', '2026-11-01T08:30:00Z'),
          worklog('2', '2026-11-01T09:30:00Z'),
        ],
      };
    },
  });
  assert.deepEqual(
    report.entries.map((entry) => entry.date),
    ['2026-11-01', '2026-11-01'],
  );
});

test('defaults to the Mac zone for FH-8864 and filters day and month boundaries in that zone', async () => {
  const originalZone = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    const request = async (path) => {
      if (path === 'myself') return { ...user, timeZone: 'Europe/Berlin' };
      if (path === 'field') return [];
      if (path === 'search/jql')
        return { issues: [{ ...issue, key: 'FH-8864' }], isLast: true };
      return {
        startAt: 0,
        total: 2,
        worklogs: [
          {
            ...worklog('188464', '2026-09-09T23:56:00.000+0200'),
            timeSpentSeconds: 28800,
          },
          worklog('month-end', '2026-09-30T23:56:00.000+0200'),
        ],
      };
    };
    const report = await getReport({
      start: '2026-09-10',
      end: '2026-09-11',
      request,
    });
    assert.equal(
      report.user.timeZone,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].issueKey, 'FH-8864');
    assert.equal(report.entries[0].date, '2026-09-10');
    assert.equal(report.entries[0].started, '2026-09-10T03:26:00.000+05:30');
    assert.equal(report.entries[0].seconds, 28800);
    const previousDay = await getReport({
      start: '2026-09-09',
      end: '2026-09-10',
      request,
    });
    assert.deepEqual(previousDay.entries, []);
    const september = await getReport({
      start: '2026-09-01',
      end: '2026-10-01',
      request,
    });
    assert.deepEqual(
      september.entries.map((entry) => entry.date),
      ['2026-09-10'],
    );
    const october = await getReport({
      start: '2026-10-01',
      end: '2026-10-02',
      request,
    });
    assert.deepEqual(
      october.entries.map((entry) => entry.date),
      ['2026-10-01'],
    );
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test('reports issue story points including zero, missing and conflicting fields', async () => {
  const fields = [
    { id: 'customfield_10', name: 'Story Points' },
    { id: 'customfield_20', name: 'Story point estimate' },
    { id: 'customfield_30', name: 'Other' },
  ];
  const issues = [
    { id: '1', key: 'TEST-1', fields: { summary: 'Zero', customfield_10: 0 } },
    {
      id: '2',
      key: 'TEST-2',
      fields: { summary: 'Estimate', customfield_20: 2.5 },
    },
    { id: '3', key: 'TEST-3', fields: { summary: 'Missing' } },
    {
      id: '4',
      key: 'TEST-4',
      fields: { summary: 'Conflict', customfield_10: 3, customfield_20: 5 },
    },
  ];
  const request = async (path, body) => {
    if (path === 'myself') return user;
    if (path === 'field') return fields;
    if (path === 'search/jql') {
      assert.deepEqual(body.fields, [
        'summary',
        'timeoriginalestimate',
        'timespent',
        'duedate',
        'customfield_10',
        'customfield_20',
      ]);
      return { issues, isLast: true };
    }
    return {
      startAt: 0,
      total: 1,
      worklogs: [worklog(path.split('/')[1], '2026-09-10T12:00:00Z')],
    };
  };
  const report = await getReport({
    start: '2026-09-10',
    end: '2026-09-11',
    request,
    timeZone: 'UTC',
  });
  assert.deepEqual(
    report.entries.map((entry) => [
      entry.storyPoints,
      entry.storyPointsConflict,
    ]),
    [
      [0, false],
      [2.5, false],
      [null, false],
      [null, true],
    ],
  );
  issues[0].fields.customfield_10 = 'invalid';
  await assert.rejects(
    getReport({
      start: '2026-09-10',
      end: '2026-09-11',
      request,
      timeZone: 'UTC',
    }),
    /invalid story point/,
  );
});

test('reports issue estimates, time spent and due dates, including unset and zero values', async () => {
  const issues = [
    {
      id: '1',
      key: 'TEST-1',
      fields: {
        timeoriginalestimate: 5400,
        timespent: 7200,
        duedate: '2026-09-20',
      },
    },
    {
      id: '2',
      key: 'TEST-2',
      fields: { timeoriginalestimate: 0, timespent: 0, duedate: null },
    },
    { id: '3', key: 'TEST-3', fields: {} },
  ];
  const request = async (path) => {
    if (path === 'myself') return user;
    if (path === 'field') return [];
    if (path === 'search/jql') return { issues, isLast: true };
    return {
      startAt: 0,
      total: 1,
      worklogs: [worklog(path.split('/')[1], '2026-09-10T12:00:00Z')],
    };
  };
  const options = {
    start: '2026-09-10',
    end: '2026-09-11',
    request,
    timeZone: 'UTC',
  };
  const report = await getReport(options);
  assert.deepEqual(
    report.entries.map((entry) => [
      entry.originalEstimateSeconds,
      entry.timeSpentSeconds,
      entry.dueDate,
    ]),
    [
      [5400, 7200, '2026-09-20'],
      [0, 0, null],
      [null, null, null],
    ],
  );
  issues[0].fields.timespent = -1;
  await assert.rejects(getReport(options), /invalid time spent/);
  issues[0].fields.timespent = 7200;
  issues[0].fields.timeoriginalestimate = -1;
  await assert.rejects(getReport(options), /invalid original estimate/);
  issues[0].fields.timeoriginalestimate = 5400;
  issues[0].fields.duedate = '2026-02-30';
  await assert.rejects(getReport(options), /invalid due date/);
});

test('uses scoped-token gateway and never exposes upstream response bodies', async () => {
  const cloudId = '8e3cd3a8-f987-45c6-96ba-44e0296173fa';
  const request = makeRequest(
    { email: 'test@example.com', token: 'test-only', cloudId },
    async (url, options) => {
      assert.equal(
        url,
        `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
      );
      assert.equal(options.redirect, 'error');
      return new Response('sensitive upstream details', { status: 401 });
    },
  );
  await assert.rejects(request('myself'), /Jira rejected your credentials/);
  assert.throws(() => makeRequest({}), /not configured/);
});

test('supports PUT and a bodyless DELETE with Jira 204 success', async () => {
  const calls = [];
  const request = makeRequest(
    { email: 'test@example.com', token: 'test-only' },
    async (url, options) => {
      calls.push({ url, ...options });
      return options.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json({ id: '2' });
    },
  );
  assert.deepEqual(
    await request(
      'issue/100/worklog/2',
      { timeSpentSeconds: 60 },
      undefined,
      'PUT',
    ),
    { id: '2' },
  );
  assert.equal(
    await request(
      'issue/100/worklog/2?adjustEstimate=leave',
      undefined,
      undefined,
      'DELETE',
    ),
    null,
  );
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].body, undefined);
});

test('work-log version detects concurrent description, time, author and visibility changes', () => {
  const original = worklog('2', '2026-09-10T09:00:12.345+0530');
  const version = worklogVersion(original);
  assert.equal(worklogVersion(structuredClone(original)), version);
  for (const patch of [
    { updated: 'new' },
    { started: '2026-09-11T09:00:00+0530' },
    { timeSpentSeconds: 60 },
    { comment: null },
    { author: { accountId: 'other' } },
    { visibility: { type: 'role', value: 'Developers' } },
  ]) {
    assert.notEqual(worklogVersion({ ...original, ...patch }), version);
  }
});
