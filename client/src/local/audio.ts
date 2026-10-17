// Recorded clips kept on the device (Cache Storage, shared by accounts:
// they hold no user data), so read-aloud works offline once a clip has
// played. The service worker stays out of /api; this is page code.

const CACHE = 'hanyu-audio-v1';

const clipUrl = (key: string) => `/api/audio/${encodeURIComponent(key)}`;

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE);
  } catch {
    // Not a secure context, or storage is blocked.
    return null;
  }
}

/** Fetches a clip and caches it; null if there's no recording or no network. */
async function download(
  key: string,
  cache: Cache | null,
  cached?: Response,
): Promise<Blob | null> {
  const etag = cached?.headers.get('ETag');
  const res = await fetch(clipUrl(key), {
    credentials: 'same-origin',
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (res.status === 304) return null;
  if (!res.ok) {
    // Recording removed on the server: forget the local copy too.
    if (res.status === 404) await cache?.delete(clipUrl(key));
    return null;
  }
  await cache?.put(clipUrl(key), res.clone()).catch(() => {});
  return res.blob();
}

/**
 * A clip's audio: the cached copy at once (rechecked with the server in the
 * background), else downloaded. Null when there's no recording to play.
 */
export async function loadClip(key: string): Promise<Blob | null> {
  const cache = await openCache();
  const cached = await cache?.match(clipUrl(key)).catch(() => undefined);
  if (cached) {
    void download(key, cache, cached.clone()).catch(() => {});
    return cached.blob();
  }
  try {
    return await download(key, cache);
  } catch {
    return null;
  }
}
