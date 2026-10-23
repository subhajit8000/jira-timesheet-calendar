import test from 'node:test';
import assert from 'node:assert/strict';
import { editDuration, prepareWorklog, prepareWorklogUpdate } from '../shared/worklog.js';
import { reviewWorklog, saveWorklog } from './worklog.js';
import { worklogVersion } from './jira.js';

const input = { issueKey: 'fh-8864', date: '2026-09-10', time: '03:26', duration: '1h 30m', description: 'First line\nSecond line' };

test('validates duration, issue, local date, DST gaps and ambiguous times', () => {
  const entry = prepareWorklog(input, 'Asia/Kolkata');
  assert.equal(entry.seconds, 5400);
  assert.equal(entry.started, '2026-09-10T03:26:00.000+0530');
  assert.equal(entry.issueKey, 'FH-8864');
  for (const patch of [{ duration: '0h' }, { duration: '25h' }, { duration: '-1h' }, { duration: '8' }, { duration: '1.5h' }, { date: '2026-02-30' }, { time: '24:00' }, { issueKey: '../other' }, { description: 'x'.repeat(4001) }]) {
    assert.throws(() => prepareWorklog({ ...input, ...patch }, 'Asia/Kolkata'));
  }
  assert.throws(() => prepareWorklog({ ...input, date: '2026-03-08', time: '02:30' }, 'America/New_York'), /does not exist/);
  assert.throws(() => prepareWorklog({ ...input, date: '2026-11-01', time: '01:30' }, 'America/New_York'), /occurs twice/);
});

test('review only reads Jira and checks paginated own work logs in local time', async () => {
  const request = async (path, body) => {
    assert.equal(body, undefined);
    if (path === 'myself') return { accountId: 'me', displayName: 'Test user' };
    if (path.includes('?fields=')) return { id: '100', key: 'FH-8864', fields: { summary: 'Test issue' } };
    const startAt = Number(new URLSearchParams(path.split('?')[1]).get('startAt'));
    return { startAt, total: 2, worklogs: [{
      id: String(startAt), author: { accountId: startAt ? 'other' : 'me' },
      started: '2026-09-09T23:56:00.000+0200', timeSpentSeconds: 28800,
    }] };
  };
  const review = await reviewWorklog(input, request, 'Asia/Kolkata');
  assert.equal(review.existingCount, 1);
  assert.equal(review.existingSeconds, 28800);
  assert.equal(review.summary, 'Test issue');
});

test('save sends Jira local offset, ADF description, exact seconds, and leaves estimate unchanged', async () => {
  const review = { ...prepareWorklog(input, 'Asia/Kolkata'), issueId: '100', url: 'https://example.com' };
  let calls = 0;
  const saved = await saveWorklog(review, async (path, body) => {
    calls += 1;
    assert.equal(path, 'issue/100/worklog?adjustEstimate=leave');
    assert.equal(body.timeSpentSeconds, 5400);
    assert.equal(body.started, '2026-09-10T03:26:00.000+0530');
    assert.equal(body.comment.content[1].content[0].text, 'Second line');
    return { id: 'test-only' };
  });
  assert.equal(calls, 1);
  assert.equal(saved.id, 'test-only');
  await assert.rejects(saveWorklog(review, async () => { throw new Error('network'); }), /Check.*Jira before trying again/);
});

function mutationFixture(action = 'update') {
  const log = {
    id: '2', issueId: '100', author: { accountId: 'me' }, updated: '2026-09-10T12:00:00Z',
    started: '2026-09-10T09:00:12.345+0530', timeSpentSeconds: 3601,
    comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original', marks: [{ type: 'strong' }] }] }] },
    visibility: { type: 'role', value: 'Developers' },
  };
  const submitted = { action, issueId: '100', worklogId: '2', version: worklogVersion(log), date: '2026-09-10', time: '09:00', duration: editDuration(log.timeSpentSeconds), description: 'Ignored replacement' };
  const writes = [];
  const request = async (path, body, signal, method) => {
    if (method) { writes.push({ path, body, method }); return method === 'DELETE' ? null : { id: '2' }; }
    assert.equal(body, undefined);
    if (path === 'myself') return { accountId: 'me', displayName: 'Test user' };
    if (path.includes('?fields=')) return { id: '100', key: 'TEST-1', fields: { summary: 'Test issue' } };
    assert.equal(path, 'issue/100/worklog/2');
    return structuredClone(log);
  };
  return { log, submitted, writes, request };
}

test('update preserves untouched seconds, timestamp precision and rich description', async () => {
  const fixture = mutationFixture();
  const review = await reviewWorklog(fixture.submitted, fixture.request, 'Asia/Kolkata');
  assert.equal(fixture.writes.length, 0);
  assert.equal(review.description, 'Original');
  assert.equal(review.issueKey, 'TEST-1');
  assert.equal(review.seconds, 3601);
  assert.equal(review.started, fixture.log.started);
  const saved = await saveWorklog(review, fixture.request);
  assert.equal(saved.action, 'update');
  assert.deepEqual(fixture.writes, [{ path: 'issue/100/worklog/2?adjustEstimate=leave', method: 'PUT', body: { started: fixture.log.started, timeSpentSeconds: 3601 } }]);
});

test('update changes local date and duration, and explicitly replaces or clears description', async () => {
  for (const description of ['New description', '']) {
    const fixture = mutationFixture();
    const review = await reviewWorklog({ ...fixture.submitted, date: '2026-09-11', time: '10:30', duration: '2h', description, replaceDescription: true }, fixture.request, 'Asia/Kolkata');
    await saveWorklog(review, fixture.request);
    const body = fixture.writes[0].body;
    assert.equal(body.started, '2026-09-11T10:30:00.000+0530');
    assert.equal(body.timeSpentSeconds, 7200);
    assert.deepEqual(body.comment.content[0].content, description ? [{ type: 'text', text: description }] : []);
    assert.equal(body.visibility, undefined);
  }
});

test('delete reviews authoritative server values and sends a bodyless DELETE', async () => {
  const fixture = mutationFixture('delete');
  const review = await reviewWorklog({ ...fixture.submitted, date: '1900-01-01', duration: '99h' }, fixture.request, 'Asia/Kolkata');
  assert.equal(review.date, '2026-09-10');
  assert.equal(review.seconds, 3601);
  assert.equal(fixture.writes.length, 0);
  assert.equal((await saveWorklog(review, fixture.request)).action, 'delete');
  assert.deepEqual(fixture.writes, [{ path: 'issue/100/worklog/2?adjustEstimate=leave', body: undefined, method: 'DELETE' }]);
});

test('ownership and stale-entry checks block mutations before review and again before saving', async () => {
  for (const action of ['update', 'delete']) {
    for (const changedAfterReview of [false, true]) {
      for (const ownershipChange of [false, true]) {
        const fixture = mutationFixture(action);
        const review = changedAfterReview ? await reviewWorklog(fixture.submitted, fixture.request, 'Asia/Kolkata') : null;
        if (ownershipChange) fixture.log.author.accountId = 'other';
        else fixture.log.timeSpentSeconds = 600;
        await assert.rejects(changedAfterReview ? saveWorklog(review, fixture.request) : reviewWorklog(fixture.submitted, fixture.request), error => error.status === (ownershipChange ? 403 : 409));
        assert.equal(fixture.writes.length, 0);
      }
    }
  }
  const fixture = mutationFixture();
  await assert.rejects(reviewWorklog({ ...fixture.submitted, worklogId: '../2' }, fixture.request), /Invalid work log identity/);
  await assert.rejects(reviewWorklog({ ...fixture.submitted, action: 'invalid' }, fixture.request), /Unknown work log action/);
});

test('unchanged legacy values and ambiguous DST timestamps are preserved, not rounded', () => {
  const original = { started: '2026-11-01T01:30:12.345-0400', seconds: 0, comment: 'x'.repeat(5000) };
  const entry = prepareWorklogUpdate({ issueKey: 'TEST-1', date: '2026-11-01', time: '01:30', duration: '0m' }, original, 'America/New_York');
  assert.equal(entry.started, original.started);
  assert.equal(entry.seconds, 0);
  assert.equal(entry.description, original.comment);
});

test('mutation timeouts are not automatically retried', async () => {
  const fixture = mutationFixture('delete');
  const review = await reviewWorklog(fixture.submitted, fixture.request, 'Asia/Kolkata');
  let attempts = 0;
  await assert.rejects(saveWorklog(review, async (path, body, signal, method) => {
    if (method) { attempts += 1; throw new Error('timeout'); }
    return fixture.request(path, body, signal, method);
  }), /not confirmed.*Check Jira/);
  assert.equal(attempts, 1);
});