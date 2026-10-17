const KEY = 'hanyu.deviceId';

/**
 * A random ID for this browser, stored locally, so review logs show which
 * device they came from. Falls back to a per-page-load ID when storage is
 * unavailable (private windows).
 */
export const deviceId: string = (() => {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();
