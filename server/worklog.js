import { DateTime } from 'luxon';
import { prepareWorklog, prepareWorklogUpdate } from '../shared/worklog.js';
import { plainText, ReportError, SITE, worklogVersion } from './jira.js';

export async function reviewWorklog(
  input,
  request,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  if (input?.action === 'update' || input?.action === 'delete')
    return reviewExistingWorklog(input, request, timeZone);
  if (input?.action !== undefined && input.action !== 'create')
    throw new ReportError('Unknown work log action.', 400);
  let entry;
  try {
    entry = prepareWorklog(input, timeZone);
  } catch (error) {
    throw new ReportError(error.message, 400);
  }
  const user = await request('myself');
  if (!user.accountId)
    throw new ReportError('Jira did not identify the current account.');
  const issue = await request(
    `issue/${encodeURIComponent(entry.issueKey)}?fields=summary`,
  );
  if (!issue.id || !issue.key)
    throw new ReportError('Jira did not return a valid issue.');
  const existingLogs = new Map();
  let startAt = 0;
  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= 200)
      throw new ReportError(
        'Too many work logs to check for duplicates. Review this issue directly in Jira.',
      );
    const date = DateTime.fromISO(entry.date, { zone: 'UTC' });
    const params = new URLSearchParams({
      startAt: String(startAt),
      maxResults: '100',
      startedAfter: String(date.minus({ days: 2 }).toMillis()),
      startedBefore: String(date.plus({ days: 2 }).toMillis()),
    });
    const page = await request(
      `issue/${encodeURIComponent(issue.id)}/worklog?${params}`,
    );
    if (
      !Array.isArray(page.worklogs) ||
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      page.startAt !== startAt
    ) {
      throw new ReportError(
        'Jira returned an invalid work log page. Duplicate check failed.',
      );
    }
    for (const log of page.worklogs) {
      if (log.author?.accountId !== user.accountId) continue;
      const started = DateTime.fromISO(log.started, { zone: timeZone });
      if (
        !started.isValid ||
        !log.id ||
        !Number.isFinite(log.timeSpentSeconds) ||
        log.timeSpentSeconds < 0
      ) {
        throw new ReportError(
          'Jira returned an invalid work log. Duplicate check failed.',
        );
      }
      if (started.toISODate() === entry.date)
        existingLogs.set(log.id, log.timeSpentSeconds);
    }
    startAt += page.worklogs.length;
    if (startAt >= page.total) break;
    if (!page.worklogs.length)
      throw new ReportError(
        'Jira pagination stopped early. Duplicate check failed.',
      );
  }
  return {
    ...entry,
    action: 'create',
    issueId: issue.id,
    issueKey: issue.key,
    summary: issue.fields?.summary || issue.key,
    accountName: user.displayName || 'Current Jira account',
    url: `${SITE}/browse/${encodeURIComponent(issue.key)}`,
    existingCount: existingLogs.size,
    existingSeconds: [...existingLogs.values()].reduce(
      (total, seconds) => total + seconds,
      0,
    ),
  };
}

async function readOwnedWorklog(input, request) {
  if (
    typeof input.issueId !== 'string' ||
    !/^\d+$/.test(input.issueId) ||
    typeof input.worklogId !== 'string' ||
    !/^\d+$/.test(input.worklogId) ||
    typeof input.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.version)
  ) {
    throw new ReportError(
      'Invalid work log identity. Refresh the calendar.',
      400,
    );
  }
  const user = await request('myself');
  if (!user.accountId)
    throw new ReportError('Jira did not identify the current account.');
  const log = await request(
    `issue/${input.issueId}/worklog/${input.worklogId}`,
  );
  if (
    !log ||
    String(log.id) !== input.worklogId ||
    (log.issueId !== undefined && String(log.issueId) !== input.issueId)
  ) {
    throw new ReportError(
      'Jira returned a different work log. Refresh the calendar.',
    );
  }
  if (log.author?.accountId !== user.accountId)
    throw new ReportError('Only your own work logs can be changed here.', 403);
  if (worklogVersion(log) !== input.version)
    throw new ReportError(
      'This work log changed since it was loaded. No change was submitted. Refresh the calendar and review it again.',
      409,
    );
  if (
    !DateTime.fromISO(log.started).isValid ||
    !Number.isSafeInteger(log.timeSpentSeconds) ||
    log.timeSpentSeconds < 0
  ) {
    throw new ReportError(
      'This work log has invalid time data. Open it in Jira.',
    );
  }
  return { user, log };
}

async function reviewExistingWorklog(input, request, timeZone) {
  const { user, log } = await readOwnedWorklog(input, request);
  const issue = await request(`issue/${input.issueId}?fields=summary`);
  if (String(issue.id) !== input.issueId || !issue.key)
    throw new ReportError('Jira did not return the expected issue.');
  const started = DateTime.fromISO(log.started, { zone: timeZone });
  if (!started.isValid)
    throw new ReportError('The local reporting time zone is invalid.');
  const original = {
    date: started.toISODate(),
    time: started.toFormat('HH:mm'),
    started: log.started,
    seconds: log.timeSpentSeconds,
    comment: plainText(log.comment).trim(),
  };
  let entry = { ...original, description: original.comment };
  if (input.action === 'update') {
    try {
      entry = prepareWorklogUpdate(
        { ...input, issueKey: issue.key },
        original,
        timeZone,
      );
    } catch (error) {
      throw new ReportError(error.message, 400);
    }
  }
  return {
    ...entry,
    action: input.action,
    original,
    timeZone,
    issueId: input.issueId,
    worklogId: input.worklogId,
    version: input.version,
    issueKey: issue.key,
    summary: issue.fields?.summary || issue.key,
    accountName: user.displayName || 'Current Jira account',
    url: `${SITE}/browse/${encodeURIComponent(issue.key)}`,
  };
}

function commentDocument(description) {
  return {
    type: 'doc',
    version: 1,
    content: description.split(/\r?\n/).map((text) => ({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    })),
  };
}

export async function saveWorklog(review, request) {
  if (review.action === 'update' || review.action === 'delete') {
    await readOwnedWorklog(review, request);
    const deleting = review.action === 'delete';
    const body = deleting
      ? undefined
      : {
          started: review.started,
          timeSpentSeconds: review.seconds,
          ...(review.replaceDescription
            ? { comment: commentDocument(review.description) }
            : {}),
        };
    let result;
    try {
      result = await request(
        `issue/${review.issueId}/worklog/${review.worklogId}?adjustEstimate=leave`,
        body,
        undefined,
        deleting ? 'DELETE' : 'PUT',
      );
    } catch (error) {
      throw new ReportError(
        `The ${review.action} was not confirmed. Check Jira before trying again; it may have completed. ${error instanceof ReportError ? error.message : ''}`.trim(),
      );
    }
    if (deleting ? result !== null : String(result?.id) !== review.worklogId) {
      throw new ReportError(
        'Jira did not confirm the requested change. Check Jira before trying again; it may have completed.',
      );
    }
    return {
      id: review.worklogId,
      action: review.action,
      issueKey: review.issueKey,
      date: review.date,
      seconds: review.seconds,
      url: review.url,
    };
  }
  const body = { started: review.started, timeSpentSeconds: review.seconds };
  if (review.description) body.comment = commentDocument(review.description);
  let result;
  try {
    result = await request(
      `issue/${encodeURIComponent(review.issueId)}/worklog?adjustEstimate=leave`,
      body,
    );
  } catch (error) {
    throw new ReportError(
      `Save was not confirmed. Check this issue's Work log in Jira before trying again; it may already be saved. ${error instanceof ReportError ? error.message : ''}`.trim(),
    );
  }
  if (!result?.id)
    throw new ReportError(
      'Jira did not confirm a work log ID. Check Jira before trying again; the entry may already be saved.',
    );
  return {
    id: result.id,
    action: 'create',
    issueKey: review.issueKey,
    date: review.date,
    seconds: review.seconds,
    url: review.url,
  };
}
