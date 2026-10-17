import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadClip } from './audio';

afterEach(() => vi.unstubAllGlobals());

describe('loadClip', () => {
  it('fetches the clip by key', async () => {
    const fetch = vi.fn(
      async (_url: string) =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'audio/mpeg', ETag: '"h1"' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const blob = await loadClip('word:hsk30-00001');
    expect(blob?.size).toBe(3);
    expect(fetch.mock.calls[0]![0]).toBe('/api/audio/word%3Ahsk30-00001');
  });

  it('gives null without a recording or a connection', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    expect(await loadClip('word:x')).toBeNull();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect(await loadClip('word:x')).toBeNull();
  });
});
