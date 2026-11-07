// The URL of each view, on the History API. Going back or forward returns to
// where the page was scrolled, which the browser can't do for itself because
// phones scroll `main` rather than the document.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { StudyMode } from '@hanyu/shared';

export type Route =
  | { name: 'today' }
  | { name: 'read'; passage?: string }
  | { name: 'listen'; exercise?: string }
  | { name: 'grammar'; passage?: string }
  | { name: 'progress' }
  | { name: 'settings' }
  | { name: 'study'; mode: StudyMode };

const STUDY_MODES: readonly StudyMode[] = [
  'regular',
  'review',
  'new',
  'flagged',
];

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The view for a path; anything unknown is Today. */
export function parseRoute(pathname: string): Route {
  const [section, rest, ...extra] = pathname.split('/').filter(Boolean);
  if (extra.length) return { name: 'today' };
  const id = rest === undefined ? undefined : decoded(rest);
  if (id === null) return { name: 'today' };
  switch (section) {
    case 'read':
      return id === undefined
        ? { name: 'read' }
        : { name: 'read', passage: id };
    case 'listen':
      return id === undefined
        ? { name: 'listen' }
        : { name: 'listen', exercise: id };
    case 'grammar':
      return id === undefined
        ? { name: 'grammar' }
        : { name: 'grammar', passage: id };
    case 'progress':
    case 'settings':
      return id === undefined ? { name: section } : { name: 'today' };
    case 'study': {
      const mode = STUDY_MODES.find((m) => m === id);
      return mode ? { name: 'study', mode } : { name: 'today' };
    }
    default:
      return { name: 'today' };
  }
}

export function routePath(route: Route): string {
  const under = (section: string, id?: string) =>
    id === undefined ? `/${section}` : `/${section}/${encodeURIComponent(id)}`;
  switch (route.name) {
    case 'today':
      return '/';
    case 'read':
    case 'grammar':
      return under(route.name, route.passage);
    case 'listen':
      return under(route.name, route.exercise);
    case 'study':
      return under(route.name, route.mode);
    default:
      return `/${route.name}`;
  }
}

// --- History ----------------------------------------------------------------

/** Kept on each history entry. */
interface EntryState {
  key: string;
  /** The path this entry was opened from, for back links. */
  from?: string;
}

const entry = (): EntryState | null => history.state as EntryState | null;
const newKey = () => crypto.randomUUID();

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

// Where each history entry was scrolled to, by key. A reload forgets them.
const scrolled = new Map<string, number>();
let currentKey: string | null = null;
let cancelRestore: (() => void) | null = null;

/** Phones scroll `main`; wider screens scroll the document. */
function scroller(): Element {
  const main = document.querySelector('.app > main');
  return main && getComputedStyle(main).overflowY === 'auto'
    ? main
    : document.documentElement;
}

function rememberScroll() {
  if (currentKey) scrolled.set(currentKey, scroller().scrollTop);
}

/** Scrolls to `top` once the view has loaded enough to reach it. */
function restoreScroll(top: number) {
  cancelRestore?.();
  const deadline = performance.now() + 3000;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchstart', stop);
    cancelRestore = null;
  };
  const attempt = () => {
    const element = scroller();
    if (element.scrollHeight - element.clientHeight >= top) {
      element.scrollTop = top;
      stop();
    } else if (performance.now() < deadline) {
      frame = requestAnimationFrame(attempt);
    } else {
      stop();
    }
  };
  // Scrolling by hand wins over a view that's slow to load.
  window.addEventListener('wheel', stop, { passive: true });
  window.addEventListener('touchstart', stop, { passive: true });
  cancelRestore = stop;
  frame = requestAnimationFrame(attempt);
}

function onPopState() {
  rememberScroll();
  currentKey = entry()?.key ?? null;
  notify();
  restoreScroll((currentKey && scrolled.get(currentKey)) || 0);
}

function subscribe(listener: () => void) {
  if (!listeners.size) {
    history.scrollRestoration = 'manual';
    if (!entry()?.key) {
      history.replaceState({ ...entry(), key: newKey() }, '');
    }
    currentKey = entry()!.key;
    window.addEventListener('popstate', onPopState);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('popstate', onPopState);
  };
}

/**
 * Opens a view. `replace` swaps the current history entry, for moving sideways
 * (the next exercise) rather than deeper.
 */
export function navigate(route: Route, { replace = false } = {}) {
  const path = routePath(route);
  const current = location.pathname;
  if (path === current) return;
  cancelRestore?.();
  rememberScroll();
  const state: EntryState = {
    key: newKey(),
    from: replace ? entry()?.from : current,
  };
  if (replace) history.replaceState(state, '', path);
  else history.pushState(state, '', path);
  currentKey = state.key;
  notify();
  scroller().scrollTop = 0;
}

/**
 * Leaves a view for the one above it. Goes back when that's where the view was
 * opened from, so the list keeps its scroll position and the back button
 * doesn't return to the view just left. Opened directly from a link, there's
 * nothing to go back to.
 */
export function navigateUp(parent: Route) {
  if (entry()?.from === routePath(parent)) history.back();
  else navigate(parent, { replace: true });
}

/** The current view, updated on navigating and on back and forward. */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname);
  const route = useMemo(() => parseRoute(pathname), [pathname]);
  // An unknown address shows Today, so say so.
  useEffect(() => {
    if (routePath(route) !== pathname) navigate(route, { replace: true });
  }, [route, pathname]);
  return route;
}
