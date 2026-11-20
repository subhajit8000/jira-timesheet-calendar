import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHours, summarize, toCsv } from './report.js';

test('sums exact seconds by day and Monday-based week', () => {
  const summary = summarize([
    { date: '2026-09-06', seconds: 1800, issueKey: 'TEST-1' },
    { date: '2026-09-07', seconds: 3600, issueKey: 'TEST-1' },
    { date: '2026-09-07', seconds: 900, issueKey: 'TEST-2' },
  ]);
  assert.equal(summary.seconds, 6300);
  assert.equal(summary.days['2026-09-07'], 4500);
  assert.deepEqual(summary.weeks, { '2026-08-31': 1800, '2026-09-07': 4500 });
  assert.equal(summary.issueCount, 2);
  assert.equal(formatHours(summary.seconds), '1.75h');
  assert.equal(summarize([]).seconds, 0);
});

test('CSV quotes multiline content and neutralizes spreadsheet formulas', () => {
  const csv = toCsv([
    {
      date: '2026-09-01',
      issueKey: 'TEST-1',
      summary: '=1+1',
      seconds: 1800,
      started: '2026-09-01T09:00:00Z',
      comment: 'Quote "this"\nand that',
    },
  ]);
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"Quote ""this""\nand that"'));
  assert.ok(csv.includes('"0.5","1800"'));
});

test('CSV exports story points without turning zero into an empty value', () => {
  const csv = toCsv([
    { date: '2026-09-01', seconds: 0, storyPoints: 0 },
    { date: '2026-09-02', seconds: 0, storyPointsConflict: true },
    { date: '2026-09-03', seconds: 0, storyPoints: null },
  ]);
  const rows = csv.split('\r\n');
  assert.match(rows[0], /"Story points"$/);
  assert.match(rows[1], /,"0"$/);
  assert.match(rows[2], /,"Multiple values in Jira"$/);
  assert.match(rows[3], /,""$/);
});
