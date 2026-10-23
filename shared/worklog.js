import { DateTime } from 'luxon';

export function editDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', remainder ? `${remainder}s` : ''].filter(Boolean).join(' ') || '0m';
}

export function prepareWorklogUpdate(input, original, timeZone) {
  const started = DateTime.fromISO(original.started, { zone: timeZone });
  const sameTime = input.date === started.toISODate() && input.time === started.toFormat('HH:mm');
  const sameDuration = input.duration === editDuration(original.seconds);
  const entry = prepareWorklog({
    ...input,
    ...(sameTime ? { date: '2000-01-01', time: '12:00' } : {}),
    duration: sameDuration ? '1m' : input.duration,
    description: input.replaceDescription === true ? input.description : '',
  }, timeZone);
  return {
    ...entry, date: input.date, time: input.time,
    started: sameTime ? original.started : entry.started,
    seconds: sameDuration ? original.seconds : entry.seconds,
    description: input.replaceDescription === true ? entry.description : original.comment,
    replaceDescription: input.replaceDescription === true,
  };
}

export function prepareWorklog(input, timeZone) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter work log details.');
  const { issueKey, date, time, duration, description = '' } = input;
  if (typeof issueKey !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(issueKey.trim())) {
    throw new Error('Enter a Jira issue key, such as FH-8864.');
  }
  if (typeof duration !== 'string' || duration.length > 30) throw new Error('Enter a duration such as 8h or 1h 30m.');
  const match = duration.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/i);
  if (!match || (!match[1] && !match[2])) throw new Error('Use whole hours and minutes, such as 8h or 1h 30m.');
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400) throw new Error('Duration must be between 1 minute and 24 hours.');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Enter a valid date and start time.');
  const started = DateTime.fromISO(`${date}T${time}`, { zone: timeZone });
  if (!started.isValid || started.toFormat("yyyy-MM-dd'T'HH:mm") !== `${date}T${time}`) {
    throw new Error('This local date or time does not exist. Choose another start time.');
  }
  if (started.getPossibleOffsets().length > 1) throw new Error('This start time occurs twice during a daylight-saving change. Choose an unambiguous time.');
  if (typeof description !== 'string' || description.length > 4000) throw new Error('Description must be at most 4000 characters.');
  return {
    issueKey: issueKey.trim().toUpperCase(), date, time, timeZone,
    seconds, started: started.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZZ"),
    description: description.trim(),
  };
}