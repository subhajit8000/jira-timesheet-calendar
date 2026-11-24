import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import {
  defaultJiraFieldIds,
  isJiraFieldId,
  MAX_SELECTED_JIRA_FIELDS,
} from '../shared/jira-fields.js';

export const SITE = 'https://paragon-automation.atlassian.net';

const fallbackFields = [
  { id: 'timeoriginalestimate', name: 'Original estimate' },
  { id: 'timespent', name: 'Time spent' },
  { id: 'duedate', name: 'Due date' },
];

export class ReportError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function validateRange(start, end) {
  const first = DateTime.fromISO(start || '', { zone: 'UTC' });
  const last = DateTime.fromISO(end || '', { zone: 'UTC' });
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start || '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end || '') ||
    !first.isValid ||
    !last.isValid ||
    last <= first ||
    last.diff(first, 'days').days > 62
  ) {
    throw new ReportError(
      'Choose a valid date range of no more than 62 days.',
      400,
    );
  }
  return { first, last };
}

export function makeRequest({ email, token, cloudId }, fetcher = fetch) {
  if (!email || !token)
    throw new ReportError('Jira credentials are not configured.', 503);
  if (cloudId && !/^[a-f\d-]{36}$/i.test(cloudId)) {
    throw new ReportError('JIRA_CLOUD_ID must be a valid cloud ID.', 503);
  }
  const base = cloudId ? `https://api.atlassian.com/ex/jira/${cloudId}` : SITE;
  return async (path, body, signal, method = body ? 'POST' : 'GET') => {
    let response;
    try {
      response = await fetcher(`${base}/rest/api/3/${path}`, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
    } catch {
      throw new ReportError(
        'Jira could not be reached. Check your network or VPN, then refresh.',
      );
    }
    if (!response.ok) {
      const messages = {
        401: 'Jira rejected your credentials. Check your email, token expiry, and token type.',
        403: 'Jira denied access. Check write:jira-work and project permissions: Work on Issues, Edit Own Worklogs, or Delete Own Worklogs for the requested action.',
        404: 'A Jira resource is unavailable. Check site access and token configuration.',
        429: 'Jira rate limit reached. Wait before refreshing the report.',
      };
      throw new ReportError(
        messages[response.status] || `Jira returned HTTP ${response.status}.`,
        response.status === 429 ? 429 : 502,
      );
    }
    if (response.status === 204 && method === 'DELETE') return null;
    try {
      return await response.json();
    } catch {
      throw new ReportError('Jira returned an invalid response.');
    }
  };
}

export function plainText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'hardBreak') return '\n';
  return (
    (node.text || '') +
    (node.content || []).map(plainText).join('') +
    (['paragraph', 'listItem'].includes(node.type) ? '\n' : '')
  );
}

export async function getFieldOptions(request, signal) {
  const fields = await request('field', undefined, signal);
  if (!Array.isArray(fields))
    throw new ReportError('Jira returned an invalid field list.');
  const options = new Map(fallbackFields.map((field) => [field.id, field]));
  for (const field of fields) {
    if (
      field &&
      isJiraFieldId(field.id) &&
      typeof field.name === 'string' &&
      field.name.trim()
    ) {
      options.set(field.id, { id: field.id, name: field.name.trim() });
    }
  }
  return [...options.values()];
}

function displayFieldValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) {
    const items = value.map(displayFieldValue).filter(Boolean);
    return items.length ? items.join(', ') : null;
  }
  if (typeof value !== 'object') return null;
  if (value.type === 'doc') return plainText(value).trim() || null;
  for (const key of ['displayName', 'name', 'value', 'key', 'text']) {
    if (
      typeof value[key] === 'string' ||
      typeof value[key] === 'number' ||
      typeof value[key] === 'boolean'
    ) {
      return String(value[key]);
    }
  }
  if (value.content) return plainText(value).trim() || null;
  const parts = Object.entries(value)
    .filter(
      ([key]) => !['accountId', 'avatarUrls', 'iconUrl', 'self'].includes(key),
    )
    .map(([key, member]) => {
      const label = displayFieldValue(member);
      return label ? `${key}: ${label}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function worklogVersion(log) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: log.id,
        author: log.author?.accountId,
        updated: log.updated,
        started: log.started,
        seconds: log.timeSpentSeconds,
        comment: log.comment,
        visibility: log.visibility,
      }),
    )
    .digest('hex');
}

export async function getReport({
  start,
  end,
  request,
  signal,
  selectedFieldIds,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
  const { first, last } = validateRange(start, end);
  const user = await request('myself', undefined, signal);
  if (!user.accountId)
    throw new ReportError('Jira did not identify the current account.');
  const availableFields = await getFieldOptions(request, signal);
  const availableIds = new Set(availableFields.map((field) => field.id));
  const storyPointFields = availableFields
    .filter(
      (field) =>
        /^customfield_\d+$/.test(field.id) &&
        /^(story points|story point estimate)$/i.test(field.name),
    )
    .map((field) => field.id);
  const defaultFieldIds = defaultJiraFieldIds(availableFields);
  const selectedIds = selectedFieldIds ?? defaultFieldIds;
  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length > MAX_SELECTED_JIRA_FIELDS ||
    selectedIds.some((id) => !isJiraFieldId(id) || !availableIds.has(id)) ||
    new Set(selectedIds).size !== selectedIds.length
  ) {
    throw new ReportError(
      'Choose up to 50 fields from the Jira field list.',
      400,
    );
  }
  const requestedFieldIds = [...new Set([...selectedIds, ...storyPointFields])];
  const zone = timeZone;
  if (!DateTime.now().setZone(zone).isValid)
    throw new ReportError('The local reporting time zone is invalid.');
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${first.minus({ days: 2 }).toISODate()}" AND worklogDate < "${last.plus({ days: 2 }).toISODate()}" ORDER BY key ASC`;
  const issues = new Map();
  const tokens = new Set();
  let nextPageToken;
  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= 200)
      throw new ReportError(
        'Too many issue pages. Choose a smaller date range.',
      );
    const page = await request(
      'search/jql',
      {
        jql,
        fields: ['summary', ...requestedFieldIds],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
      signal,
    );
    if (!Array.isArray(page.issues))
      throw new ReportError('Jira returned an invalid issue page.');
    for (const issue of page.issues) {
      if (!issue.id || !issue.key)
        throw new ReportError('Jira returned an incomplete issue.');
      issues.set(issue.id, issue);
    }
    if (page.isLast === true) break;
    if (!page.nextPageToken || tokens.has(page.nextPageToken)) {
      throw new ReportError(
        'Jira issue pagination is incomplete. No partial totals are shown.',
      );
    }
    nextPageToken = page.nextPageToken;
    tokens.add(nextPageToken);
  }

  const entries = new Map();
  const issueQueue = [...issues.values()];
  async function readIssues() {
    while (issueQueue.length) {
      signal?.throwIfAborted();
      const issue = issueQueue.shift();
      const points = storyPointFields
        .map((id) => issue.fields?.[id])
        .filter((value) => value != null);
      if (
        points.some(
          (value) => typeof value !== 'number' || !Number.isFinite(value),
        )
      ) {
        throw new ReportError('Jira returned an invalid story point value.');
      }
      const storyPointsConflict = new Set(points).size > 1;
      const originalEstimateSeconds = selectedIds.includes(
        'timeoriginalestimate',
      )
        ? (issue.fields?.timeoriginalestimate ?? null)
        : null;
      const timeSpentSeconds = selectedIds.includes('timespent')
        ? (issue.fields?.timespent ?? null)
        : null;
      const dueDate = selectedIds.includes('duedate')
        ? (issue.fields?.duedate ?? null)
        : null;
      if (
        originalEstimateSeconds !== null &&
        (!Number.isSafeInteger(originalEstimateSeconds) ||
          originalEstimateSeconds < 0)
      ) {
        throw new ReportError('Jira returned an invalid original estimate.');
      }
      if (
        timeSpentSeconds !== null &&
        (!Number.isSafeInteger(timeSpentSeconds) || timeSpentSeconds < 0)
      ) {
        throw new ReportError('Jira returned an invalid time spent value.');
      }
      if (
        dueDate !== null &&
        (typeof dueDate !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
          !DateTime.fromISO(dueDate, { zone: 'UTC' }).isValid)
      ) {
        throw new ReportError('Jira returned an invalid due date.');
      }
      let startAt = 0;
      for (let pageIndex = 0; ; pageIndex += 1) {
        if (pageIndex >= 200)
          throw new ReportError(
            'Too many work log pages. Choose a smaller date range.',
          );
        const params = new URLSearchParams({
          startAt: String(startAt),
          maxResults: '100',
          startedAfter: String(first.minus({ days: 2 }).toMillis()),
          startedBefore: String(last.plus({ days: 2 }).toMillis()),
        });
        const page = await request(
          `issue/${encodeURIComponent(issue.id)}/worklog?${params}`,
          undefined,
          signal,
        );
        if (
          !Array.isArray(page.worklogs) ||
          !Number.isInteger(page.total) ||
          page.total < 0 ||
          page.startAt !== startAt
        ) {
          throw new ReportError('Jira returned an invalid work log page.');
        }
        for (const log of page.worklogs) {
          if (log.author?.accountId !== user.accountId) continue;
          const started = DateTime.fromISO(log.started, { zone });
          if (
            !started.isValid ||
            !log.id ||
            !Number.isFinite(log.timeSpentSeconds) ||
            log.timeSpentSeconds < 0
          ) {
            throw new ReportError(
              'A work log has invalid dates or hours. No partial totals are shown.',
            );
          }
          const date = started.toISODate();
          if (date < start || date >= end) continue;
          const id = `${issue.id}:${log.id}`;
          const fieldValues = Object.fromEntries(
            selectedIds.map((fieldId) => [
              fieldId,
              storyPointsConflict && storyPointFields.includes(fieldId)
                ? 'Multiple values in Jira'
                : displayFieldValue(issue.fields?.[fieldId]),
            ]),
          );
          entries.set(id, {
            id,
            issueId: String(issue.id),
            worklogId: String(log.id),
            version: worklogVersion(log),
            issueKey: issue.key,
            summary: issue.fields?.summary || issue.key,
            storyPoints: storyPointsConflict ? null : (points[0] ?? null),
            storyPointsConflict,
            originalEstimateSeconds,
            timeSpentSeconds,
            dueDate,
            fieldValues,
            date,
            started: started.toISO(),
            seconds: log.timeSpentSeconds,
            comment: plainText(log.comment).trim(),
            url: `${SITE}/browse/${encodeURIComponent(issue.key)}`,
          });
        }
        startAt += page.worklogs.length;
        if (startAt >= page.total) break;
        if (!page.worklogs.length)
          throw new ReportError(
            'Jira work log pagination stopped early. No partial totals are shown.',
          );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, issueQueue.length) }, readIssues),
  );
  return {
    user: { name: user.displayName || 'My Jira account', timeZone: zone },
    start,
    end,
    fetchedAt: new Date().toISOString(),
    demo: false,
    availableFields,
    defaultFieldIds,
    selectedFieldIds: selectedIds,
    entries: [...entries.values()].sort((before, after) =>
      before.started.localeCompare(after.started),
    ),
  };
}
