import {
  isJiraFieldId,
  MAX_SELECTED_JIRA_FIELDS,
} from '../shared/jira-fields.js';

const storageKey = 'timesheet-selected-jira-fields';

function normalizeFieldIds(value) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SELECTED_JIRA_FIELDS ||
    !value.every(isJiraFieldId) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value;
}

export function readDetailFields(browser) {
  try {
    const saved = browser.localStorage.getItem(storageKey);
    if (saved === null) return { fieldIds: null, storageError: false };
    const fieldIds = normalizeFieldIds(JSON.parse(saved));
    return fieldIds
      ? { fieldIds, storageError: false }
      : { fieldIds: null, storageError: true };
  } catch {
    return { fieldIds: null, storageError: true };
  }
}

export function saveDetailFields(browser, fieldIds) {
  if (normalizeFieldIds(fieldIds) === null) return false;
  try {
    browser.localStorage.setItem(storageKey, JSON.stringify(fieldIds));
    return true;
  } catch {
    return false;
  }
}

export function clearDetailFields(browser) {
  try {
    browser.localStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}
