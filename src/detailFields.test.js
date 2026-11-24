import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDetailFields,
  readDetailFields,
  saveDetailFields,
} from './detailFields.js';

test('uses defaults and restores saved field visibility', () => {
  let saved = null;
  const browser = {
    localStorage: {
      getItem: (key) => {
        assert.equal(key, 'timesheet-detail-fields');
        return saved;
      },
      setItem: (key, value) => {
        assert.equal(key, 'timesheet-detail-fields');
        saved = value;
      },
    },
  };
  assert.deepEqual(readDetailFields(browser), {
    fields: defaultDetailFields,
    storageError: false,
  });
  const fields = { ...defaultDetailFields, storyPoints: false, dueDate: false };
  assert.equal(saveDetailFields(browser, fields), true);
  assert.deepEqual(readDetailFields(browser), {
    fields,
    storageError: false,
  });
});

test('uses defaults and reports malformed or unavailable display settings', () => {
  const browser = {
    localStorage: { getItem: () => '{invalid' },
  };
  assert.deepEqual(readDetailFields(browser), {
    fields: defaultDetailFields,
    storageError: true,
  });
  browser.localStorage.getItem = () => '{"storyPoints":"yes"}';
  assert.deepEqual(readDetailFields(browser), {
    fields: defaultDetailFields,
    storageError: true,
  });
  browser.localStorage.getItem = () => {
    throw new Error('Storage unavailable');
  };
  assert.deepEqual(readDetailFields(browser), {
    fields: defaultDetailFields,
    storageError: true,
  });
  assert.equal(saveDetailFields(browser, defaultDetailFields), false);
});
