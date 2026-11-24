import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearDetailFields,
  readDetailFields,
  saveDetailFields,
} from './detailFields.js';

test('uses no saved selection by default and restores saved Jira field IDs', () => {
  let saved = null;
  const browser = {
    localStorage: {
      getItem: (key) => {
        assert.equal(key, 'timesheet-selected-jira-fields');
        return saved;
      },
      setItem: (key, value) => {
        assert.equal(key, 'timesheet-selected-jira-fields');
        saved = value;
      },
      removeItem: (key) => {
        assert.equal(key, 'timesheet-selected-jira-fields');
        saved = null;
      },
    },
  };
  assert.deepEqual(readDetailFields(browser), {
    fieldIds: null,
    storageError: false,
  });
  const fieldIds = ['duedate', 'customfield_10020'];
  assert.equal(saveDetailFields(browser, fieldIds), true);
  assert.deepEqual(readDetailFields(browser), {
    fieldIds,
    storageError: false,
  });
  assert.equal(saveDetailFields(browser, []), true);
  assert.deepEqual(readDetailFields(browser).fieldIds, []);
  assert.equal(clearDetailFields(browser), true);
  assert.deepEqual(readDetailFields(browser).fieldIds, null);
});

test('reports malformed, excessive or unavailable display field settings', () => {
  const browser = {
    localStorage: { getItem: () => '{invalid' },
  };
  assert.deepEqual(readDetailFields(browser), {
    fieldIds: null,
    storageError: true,
  });
  browser.localStorage.getItem = () => '["not a field"]';
  assert.equal(readDetailFields(browser).storageError, true);
  browser.localStorage.getItem = () => {
    throw new Error('Storage unavailable');
  };
  assert.deepEqual(readDetailFields(browser), {
    fieldIds: null,
    storageError: true,
  });
  assert.equal(saveDetailFields(browser, ['invalid id']), false);
  assert.equal(
    saveDetailFields(browser, Array(51).fill('customfield_1')),
    false,
  );
  assert.equal(saveDetailFields(browser, ['9invalid']), false);
  assert.equal(clearDetailFields(browser), false);
});
