export const defaultDetailFields = {
  storyPoints: true,
  originalEstimate: true,
  timeSpent: true,
  dueDate: true,
};

const storageKey = 'timesheet-detail-fields';

function normalizeFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = { ...defaultDetailFields };
  for (const key of Object.keys(defaultDetailFields)) {
    if (key in value) {
      if (typeof value[key] !== 'boolean') return null;
      fields[key] = value[key];
    }
  }
  return fields;
}

export function readDetailFields(browser) {
  try {
    const saved = browser.localStorage.getItem(storageKey);
    if (saved === null)
      return { fields: { ...defaultDetailFields }, storageError: false };
    const fields = normalizeFields(JSON.parse(saved));
    return fields
      ? { fields, storageError: false }
      : { fields: { ...defaultDetailFields }, storageError: true };
  } catch {
    return { fields: { ...defaultDetailFields }, storageError: true };
  }
}

export function saveDetailFields(browser, fields) {
  try {
    browser.localStorage.setItem(storageKey, JSON.stringify(fields));
    return true;
  } catch {
    return false;
  }
}
