const themeKey = 'timesheet-theme';

export function readTheme(browser) {
  const systemTheme = browser.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
  try {
    const saved = browser.localStorage.getItem(themeKey);
    return {
      theme: saved === 'dark' || saved === 'light' ? saved : systemTheme,
      storageError: false,
    };
  } catch {
    return { theme: systemTheme, storageError: true };
  }
}

export function saveTheme(browser, theme) {
  try {
    browser.localStorage.setItem(themeKey, theme);
    return true;
  } catch {
    return false;
  }
}
