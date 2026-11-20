import express from 'express';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  getReport,
  makeRequest,
  ReportError,
  SITE,
  validateRange,
} from './jira.js';
import { reviewWorklog, saveWorklog } from './worklog.js';

function sampleReport(start, end) {
  const { first, last } = validateRange(start, end);
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
      entries.push({
        id: `sample-${date.toISODate()}-${entryIndex}`,
        issueKey: `SAMPLE-${101 + taskIndex}`,
        summary: tasks[taskIndex],
        storyPoints: [3, 5, null, 0][taskIndex],
        storyPointsConflict: false,
        originalEstimateSeconds: [28800, 14400, null, 0][taskIndex],
        dueDate: taskIndex === 2 ? null : first.endOf('month').toISODate(),
        date: date.toISODate(),
        started: date.set({ hour: 9 + entryIndex * 4 }).toISO(),
        seconds: (entryIndex ? 2.5 : 4) * 3600,
        comment: 'Sample entry',
        url: null,
      });
    }
  }
  return {
    start,
    end,
    entries,
    demo: true,
    fetchedAt: new Date().toISOString(),
    user: { name: 'Sample account', timeZone: 'UTC' },
  };
}

export function createApp({
  config = {},
  reportProvider = getReport,
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
  app.get('/api/report', async (req, res) => {
    const { start, end, demo } = req.query;
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let counted = false;
    try {
      if (typeof start !== 'string' || typeof end !== 'string')
        throw new ReportError('Start and end dates are required.', 400);
      validateRange(start, end);
      if (demo === '1') return res.json(sampleReport(start, end));
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
