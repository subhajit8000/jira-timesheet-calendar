export const MAX_SELECTED_JIRA_FIELDS = 50;

const defaultSystemFields = ['timeoriginalestimate', 'timespent', 'duedate'];

export function isJiraFieldId(value) {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(value)
  );
}

export function defaultJiraFieldIds(fields) {
  const availableIds = new Set(fields.map((field) => field.id));
  return [
    ...defaultSystemFields.filter((id) => availableIds.has(id)),
    ...fields
      .filter(
        (field) =>
          /^customfield_\d+$/.test(field.id) &&
          /^(story points|story point estimate)$/i.test(field.name),
      )
      .map((field) => field.id),
  ].slice(0, MAX_SELECTED_JIRA_FIELDS);
}
