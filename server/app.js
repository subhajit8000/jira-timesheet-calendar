import express from 'express';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  defaultJiraFieldIds,
  isJiraFieldId,
  MAX_SELECTED_JIRA_FIELDS,
} from '../shared/jira-fields.js';
import {
  getReport,
  getFieldOptions,
  makeRequest,
  ReportError,
  SITE,
  validateRange,
} from './jira.js';
import { reviewWorklog, saveWorklog } from './worklog.js';

const sampleFields = [
  { id: 'customfield_10000', name: 'Story points' },
  { id: 'timeoriginalestimate', name: 'Original estimate' },
  { id: 'timespent', name: 'Time spent' },
  { id: 'duedate', name: 'Due date' },
];

function parseSelectedFieldIds(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new ReportError('Selected Jira fields are invalid.', 400);
  const fieldIds = value ? value.split(',') : [];
  if (
    fieldIds.length > MAX_SELECTED_JIRA_FIELDS ||
    fieldIds.some((id) => !isJiraFieldId(id)) ||
    new Set(fieldIds).size !== fieldIds.length
  ) {
    throw new ReportError('Choose up to 50 valid Jira fields.', 400);
  }
  return fieldIds;
}

function sampleReport(start, end, selectedFieldIds) {
  const { first, last } = validateRange(start, end);
  const defaultFieldIds = defaultJiraFieldIds(sampleFields);
  const selectedIds = selectedFieldIds ?? defaultFieldIds;
  const availableFields = [
    ...sampleFields,
    ...selectedIds
      .filter((id) => !sampleFields.some((field) => field.id === id))
      .map((id) => ({ id, name: id })),
  ];
  const entries = [];
  const tasks = [
    'Calendar integration',
    'Review and testing',
    'Service configuration',
    'Planning',
  ];
  for (let date = first; date < last; date = date.plus({ days: 1 })) {
    if (date.weekday > 5 || date.day % 7 === 0) continue;
    for (let entryIndex = 0; entryIndex < 2; entryIndex += 1) {
      const taskIndex = (date.day + entryIndex) % tasks.length;
      const entry = {
        id: `sample-${date.toISODate()}-${entryIndex}`,
        issueKey: `SAMPLE-${101 + taskIndex}`,
        summary: tasks[taskIndex],
        storyPoints: [3, 5, null, 0][taskIndex],
        storyPointsConflict: false,
        originalEstimateSeconds: [28800, 14400, null, 0][taskIndex],
        timeSpentSeconds: [43200, 36000, null, 0][taskIndex],
        dueDate: taskIndex === 2 ? null : first.endOf('month').toISODate(),
        date: date.toISODate(),
        started: date.set({ hour: 9 + entryIndex * 4 }).toISO(),
        seconds: (entryIndex ? 2.5 : 4) * 3600,
        comment: 'Sample entry',
        url: null,
      };
      const values = {
        customfield_10000: entry.storyPoints,
        timeoriginalestimate: entry.originalEstimateSeconds,
        timespent: entry.timeSpentSeconds,
        duedate: entry.dueDate,
      };
      entries.push({
        ...entry,
        fieldValues: Object.fromEntries(
          selectedIds.map((id) => [
            id,
            values[id] == null ? null : String(values[id]),
          ]),
        ),
      });
    }
  }
  return {
    start,
    end,
    entries,
    demo: true,
    availableFields,
    defaultFieldIds,
    selectedFieldIds: selectedIds,
    fetchedAt: new Date().toISOString(),
    user: { name: 'Sample account', timeZone: 'UTC' },
  };
}

export function createApp({
  config = {},
  reportProvider = getReport,
  fieldProvider = getFieldOptions,
  reviewProvider = reviewWorklog,
  saveProvider = saveWorklog,
} = {}) {
  const app = express();
  const csrfToken = randomUUID();
  const reviews = new Map();
  const activeMutations = new Set();
  const reviewLifetime = 10 * 60 * 1000;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    const origin = req.headers.origin;
    if (
      !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
      (origin && origin !== `http://${host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      return res.status(403).json({ error: 'Local access only.' });
    }
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      if (
        req.method !== 'POST' ||
        !['/worklogs/preview', '/worklogs'].includes(req.path)
      ) {
        return res.status(405).json({ error: 'Method not allowed.' });
      }
      if (
        req.headers.origin !== `http://${req.headers.host}` ||
        req.headers['x-csrf-token'] !== csrfToken
      ) {
        return res
          .status(403)
          .json({ error: 'Reload the calendar before submitting a work log.' });
      }
      if (!req.is('application/json'))
        return res.status(415).json({ error: 'JSON is required.' });
    }
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }));
  app.get('/api/status', (req, res) => {
    res.json({
      configured: Boolean(config.email && config.token),
      site: SITE,
      csrfToken,
    });
  });
  let activePreviews = 0;
  app.post('/api/worklogs/preview', async (req, res) => {
    if (activePreviews >= 2)
      return res
        .status(429)
        .json({ error: 'Another review is loading. Try again shortly.' });
    activePreviews += 1;
    try {
      for (const [id, record] of reviews) {
        if (record.expiresAt <= Date.now() && record.state !== 'saving')
          reviews.delete(id);
      }
      if (reviews.size >= 200)
        throw new ReportError(
          'Too many reviews. Wait before creating another.',
          429,
        );
      const review = await reviewProvider(req.body, makeRequest(config));
      const reviewId = randomUUID();
      const expiresAt = Date.now() + reviewLifetime;
      reviews.set(reviewId, { review, expiresAt, state: 'ready' });
      res.json({ ...review, reviewId, expiresAt });
    } catch (error) {
      res.status(error instanceof ReportError ? error.status : 502).json({
        error:
          error instanceof ReportError
            ? error.message
            : 'Could not review this work log. No entry was submitted.',
      });
    } finally {
      activePreviews -= 1;
    }
  });
  app.post('/api/worklogs', async (req, res) => {
    if (req.body?.confirmed !== true) {
      return res
        .status(400)
        .json({ error: 'Review and confirm the requested action.' });
    }
    const record = reviews.get(req.body.reviewId);
    if (
      !record ||
      (record.state === 'ready' && record.expiresAt <= Date.now())
    ) {
      return res.status(410).json({
        error:
          'This review expired or the server restarted. Check Jira before starting a new review.',
      });
    }
    const mutation = ['update', 'delete'].includes(record.review.action);
    if (
      mutation
        ? req.body.action !== record.review.action
        : req.body.duplicateCheckAcknowledged !== true
    ) {
      return res.status(400).json({
        error: 'Confirm the reviewed action and any duplicate warning.',
      });
    }
    if (record.state === 'ready') {
      const mutationKey = mutation
        ? `${record.review.issueId}:${record.review.worklogId}`
        : null;
      if (mutationKey && activeMutations.has(mutationKey)) {
        return res.status(409).json({
          error:
            'Another change to this entry is in progress. Check Jira and refresh before trying again.',
        });
      }
      if (mutationKey) activeMutations.add(mutationKey);
      record.state = 'saving';
      record.result = (async () => {
        try {
          const saved = await saveProvider(record.review, makeRequest(config));
          record.state = 'saved';
          return { status: mutation ? 200 : 201, body: saved };
        } catch (error) {
          record.state = 'failed';
          return {
            status: error instanceof ReportError ? error.status : 502,
            body: {
              error:
                error instanceof ReportError
                  ? error.message
                  : 'Change was not confirmed. Check Jira before trying again; it may have completed.',
            },
          };
        } finally {
          if (mutationKey) activeMutations.delete(mutationKey);
        }
      })();
    }
    const result = await record.result;
    if (!res.destroyed) res.status(result.status).json(result.body);
  });
  let activeRequests = 0;
  app.get('/api/fields', async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let counted = false;
    try {
      if (req.query.demo === '1') return res.json({ fields: sampleFields });
      if (activeRequests >= 2)
        throw new ReportError(
          'A Jira request is already loading. Try again shortly.',
          429,
        );
      activeRequests += 1;
      counted = true;
      const fields = await fieldProvider(
        makeRequest(config),
        AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      );
      if (!res.destroyed) res.json({ fields });
    } catch (error) {
      abort.abort();
      if (!res.destroyed)
        res.status(error instanceof ReportError ? error.status : 502).json({
          error:
            error instanceof ReportError
              ? error.message
              : 'Jira fields could not be loaded. Try again.',
        });
    } finally {
      if (counted) activeRequests -= 1;
    }
  });
  app.get('/api/report', async (req, res) => {
    const { start, end, demo, fields } = req.query;
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let counted = false;
    try {
      if (typeof start !== 'string' || typeof end !== 'string')
        throw new ReportError('Start and end dates are required.', 400);
      validateRange(start, end);
      const selectedFieldIds = parseSelectedFieldIds(fields);
      if (demo === '1')
        return res.json(sampleReport(start, end, selectedFieldIds));
      if (activeRequests >= 2)
        throw new ReportError(
          'A report is already loading. Try again shortly.',
          429,
        );
      activeRequests += 1;
      counted = true;
      const report = await reportProvider({
        start,
        end,
        request: makeRequest(config),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
        selectedFieldIds,
      });
      if (!res.destroyed) res.json(report);
    } catch (error) {
      abort.abort();
      if (!res.destroyed)
        res.status(error instanceof ReportError ? error.status : 502).json({
          error:
            error instanceof ReportError
              ? error.message
              : 'The report could not be completed. Refresh to try again.',
        });
    } finally {
      if (counted) activeRequests -= 1;
    }
  });
  app.use('/api', (req, res) =>
    res.status(404).json({ error: 'Unknown endpoint.' }),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res
      .status(error.type === 'entity.too.large' ? 413 : 400)
      .json({ error: 'Invalid request body.' });
  });
  return app;
}
