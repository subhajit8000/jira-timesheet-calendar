import { DateTime } from 'luxon';

export function formatHours(seconds) {
  return `${Number((seconds / 3600).toFixed(2))}h`;
}

export function summarize(entries) {
  const days = {};
  const weeks = {};
  const issues = new Set();
  let seconds = 0;
  for (const entry of entries) {
    seconds += entry.seconds;
    days[entry.date] = (days[entry.date] || 0) + entry.seconds;
    const week = DateTime.fromISO(entry.date, { zone: 'UTC' })
      .startOf('week')
      .toISODate();
    weeks[week] = (weeks[week] || 0) + entry.seconds;
    issues.add(entry.issueKey);
  }
  return { seconds, days, weeks, issueCount: issues.size };
}

export function toCsv(entries) {
  const escapeCell = (value) => {
    let text = String(value ?? '');
    if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [
    [
      'Date',
      'Issue',
      'Summary',
      'Hours',
      'Seconds',
      'Started',
      'Description',
      'Story points',
    ],
    ...entries.map((entry) => [
      entry.date,
      entry.issueKey,
      entry.summary,
      Number((entry.seconds / 3600).toFixed(4)),
      entry.seconds,
      entry.started,
      entry.comment,
      entry.storyPointsConflict ? 'Multiple values in Jira' : entry.storyPoints,
    ]),
  ]
    .map((row) => row.map(escapeCell).join(','))
    .join('\r\n');
}
