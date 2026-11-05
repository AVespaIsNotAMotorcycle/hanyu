import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

// Per device. Unset follows the system; index.html applies it before paint.
const KEY = 'hanyu.theme';

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)');

function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return systemDark().matches ? 'dark' : 'light';
}

function chooseTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: it lasts until the page closes.
  }
  // The browser's own bar follows the page, not the system.
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg')
    .trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', background);
  });
}

/** The theme showing, and a function to switch to the other one. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState(currentTheme);

  // Follows the system until a theme is chosen.
  useEffect(() => {
    const query = systemDark();
    const update = () => setTheme(currentTheme());
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    chooseTheme(next);
    setTheme(next);
  }
  return [theme, toggle];
}
