import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createApp } from './app.js';

test('local API protects credentials, rejects other origins and unsupported writes, validates dates, and labels samples', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const statusResponse = await fetch(`${base}/api/status`);
    assert.equal(statusResponse.headers.get('cache-control'), 'no-store');
    assert.equal((await statusResponse.json()).configured, false);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Origin: 'https://example.com' } })).status, 403);
    const invalidHostStatus = await new Promise((resolve, reject) => {
      get(`${base}/api/status`, { headers: { Host: 'evil.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(`${base}/api/report`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/report?start=invalid&end=2026-10-01`)).status, 400);
    assert.equal((await fetch(`${base}/api/report?start=2026-09-01&end=2026-10-01`)).status, 503);
    const sample = await (await fetch(`${base}/api/report?start=2026-09-01&end=2026-10-01&demo=1`)).json();
    assert.equal(sample.demo, true);
    assert.ok(sample.entries.length > 0);
    assert.equal(sample.entries[0].url, null);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('writes require same-origin CSRF, review and explicit confirmation; repeated saves write once', async () => {
  let reviewCalls = 0;
  let saveCalls = 0;
  const reviewed = { issueId: '100', issueKey: 'TEST-1', date: '2026-09-10', seconds: 3600, description: 'Reviewed description' };
  const server = createApp({
    config: { email: 'test@example.com', token: 'test-only' },
    reviewProvider: async () => { reviewCalls += 1; return reviewed; },
    saveProvider: async review => {
      saveCalls += 1;
      assert.deepEqual(review, reviewed);
      return { id: 'mock-worklog' };
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { csrfToken } = await (await fetch(`${base}/api/status`)).json();
    const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
    const post = (path, body, overrides = {}) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
    assert.equal((await post('worklogs/preview', {}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post('worklogs/preview', {}, { 'X-CSRF-Token': 'bad' })).status, 403);
    assert.equal((await post('worklogs/preview', {}, { Origin: '' })).status, 403);
    assert.equal((await post('worklogs/preview', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(reviewCalls, 0);
    const preview = await (await post('worklogs/preview', { issueKey: 'TEST-1' })).json();
    assert.equal(reviewCalls, 1);
    assert.equal(saveCalls, 0);
    assert.equal((await post('worklogs', { reviewId: preview.reviewId })).status, 400);
    assert.equal((await post('worklogs', { reviewId: 'missing', confirmed: true, duplicateCheckAcknowledged: true })).status, 410);
    const payload = { reviewId: preview.reviewId, confirmed: true, duplicateCheckAcknowledged: true, seconds: 999, description: 'Tampered' };
    const responses = await Promise.all([post('worklogs', payload), post('worklogs', payload)]);
    assert.deepEqual(responses.map(response => response.status), [201, 201]);
    assert.equal(saveCalls, 1);
    assert.equal((await post('worklogs', payload)).status, 201);
    assert.equal(saveCalls, 1);
    const malformed = await fetch(`${base}/api/worklogs/preview`, { method: 'POST', headers, body: '{' });
    assert.equal(malformed.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an uncertain save is not retried for the same review', async () => {
  let saveCalls = 0;
  const server = createApp({
    config: { email: 'test@example.com', token: 'test-only' },
    reviewProvider: async () => ({ issueId: '100' }),
    saveProvider: async () => { saveCalls += 1; throw new Error('timeout'); },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { csrfToken } = await (await fetch(`${base}/api/status`)).json();
    const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
    const preview = await (await fetch(`${base}/api/worklogs/preview`, { method: 'POST', headers, body: '{}' })).json();
    const body = JSON.stringify({ reviewId: preview.reviewId, confirmed: true, duplicateCheckAcknowledged: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${base}/api/worklogs`, { method: 'POST', headers, body });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /Check Jira before trying again/);
    }
    assert.equal(saveCalls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('update and delete require matching action confirmation and use the stored review exactly once', async () => {
  const writes = [];
  const server = createApp({
    config: { email: 'test@example.com', token: 'test-only' },
    reviewProvider: async input => ({ action: input.action, issueId: '100', worklogId: '2', seconds: 3600 }),
    saveProvider: async review => { writes.push(review); return { id: review.worklogId, action: review.action }; },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { csrfToken } = await (await fetch(`${base}/api/status`)).json();
    const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
    const post = (path, body) => fetch(`${base}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    for (const action of ['update', 'delete']) {
      const preview = await (await post('worklogs/preview', { action })).json();
      assert.equal((await post('worklogs', { reviewId: preview.reviewId, action })).status, 400);
      assert.equal((await post('worklogs', { reviewId: preview.reviewId, confirmed: true, action: 'create' })).status, 400);
      const payload = { reviewId: preview.reviewId, confirmed: true, action, issueId: '999', worklogId: '999', seconds: 999 };
      const responses = await Promise.all([post('worklogs', payload), post('worklogs', payload)]);
      assert.deepEqual(responses.map(response => response.status), [200, 200]);
      assert.deepEqual(writes.at(-1), { action, issueId: '100', worklogId: '2', seconds: 3600 });
    }
    assert.equal(writes.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('separate reviews cannot change the same work log concurrently', async () => {
  let releaseSave;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const pendingSave = new Promise(resolve => { releaseSave = resolve; });
  let writes = 0;
  const server = createApp({
    config: { email: 'test@example.com', token: 'test-only' },
    reviewProvider: async input => ({ action: input.action, issueId: '100', worklogId: '2' }),
    saveProvider: async () => { writes += 1; markStarted(); await pendingSave; return { id: '2' }; },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { csrfToken } = await (await fetch(`${base}/api/status`)).json();
    const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
    const post = (path, body) => fetch(`${base}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const first = await (await post('worklogs/preview', { action: 'update' })).json();
    const second = await (await post('worklogs/preview', { action: 'delete' })).json();
    const response = post('worklogs', { reviewId: first.reviewId, confirmed: true, action: 'update' });
    await started;
    assert.equal((await post('worklogs', { reviewId: second.reviewId, confirmed: true, action: 'delete' })).status, 409);
    releaseSave();
    assert.equal((await response).status, 200);
    assert.equal(writes, 1);
  } finally {
    releaseSave();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});