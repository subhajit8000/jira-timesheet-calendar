import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readTheme, saveTheme } from './theme.js';

test('uses a saved theme or the system preference when none is saved', () => {
  const browser = {
    matchMedia: () => ({ matches: true }),
    localStorage: {
      getItem: () => null,
      setItem: (key, value) =>
        assert.deepEqual([key, value], ['timesheet-theme', 'light']),
    },
  };
  assert.deepEqual(readTheme(browser), { theme: 'dark', storageError: false });
  browser.localStorage.getItem = () => 'light';
  assert.deepEqual(readTheme(browser), { theme: 'light', storageError: false });
  browser.localStorage.getItem = () => 'invalid';
  assert.equal(readTheme(browser).theme, 'dark');
  assert.equal(saveTheme(browser, 'light'), true);
});

test('reports unavailable storage while still applying the system preference', () => {
  const browser = {
    matchMedia: () => ({ matches: false }),
    get localStorage() {
      throw new Error('Storage unavailable');
    },
  };
  assert.deepEqual(readTheme(browser), { theme: 'light', storageError: true });
  assert.equal(saveTheme(browser, 'dark'), false);
});

test('dark theme text colors maintain readable contrast on their surfaces', async () => {
  const css = await readFile(new URL('./index.css', import.meta.url), 'utf8');
  const dark = css.match(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(dark, 'dark theme tokens are present');
  const colors = Object.fromEntries(
    [...dark.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const luminance = (hex) => {
    const components = hex
      .slice(1)
      .match(/.{2}/g)
      .map((part) => parseInt(part, 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
    return (
      components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722
    );
  };
  for (const [text, background] of [
    ['ink', 'surface'],
    ['ink', 'surface-raised'],
    ['ink', 'tint'],
    ['ink', 'surface-input'],
    ['muted', 'surface'],
    ['muted', 'surface-subtle'],
    ['muted', 'surface-today'],
    ['accent', 'surface'],
    ['accent', 'surface-raised'],
    ['accent', 'tint'],
    ['on-primary', 'primary'],
    ['on-primary', 'primary-hover'],
    ['readonly-ink', 'surface-readonly'],
    ['error-ink', 'error-bg'],
    ['warning-ink', 'warning-bg'],
  ]) {
    assert.ok(
      colors[text] && colors[background],
      `missing colors: ${text}, ${background}`,
    );
    const values = [
      luminance(colors[text]),
      luminance(colors[background]),
    ].sort((a, b) => b - a);
    assert.ok(
      (values[0] + 0.05) / (values[1] + 0.05) >= 4.5,
      `${text} on ${background} must meet 4.5:1 contrast`,
    );
  }
});
