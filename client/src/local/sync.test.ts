import 'fake-indexeddb/auto';
import type {
  CharacterContent,
  GetReviewsResponse,
  PostReviewsResponse,
  ReviewInput,
  StoredReview,
  WordNote,
} from '@hanyu/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { loadCharacters, loadContent } from './content';
import { LocalStore } from './store';
import { Sync, type SyncApi } from './sync';

/**
 * An in-memory stand-in for the server's review routes: union by ID, pulls
 * paged by storedAt then ID, like the real GET /api/reviews.
 */
class FakeServer implements SyncApi {
  logs = new Map<string, StoredReview>();
  offline = false;
  pageSize = 2;
  private clock = Date.parse('2026-10-16T12:00:00Z');

  async post<T>(path: string, body: unknown): Promise<T> {
    if (this.offline) throw new TypeError('Failed to fetch');
    expect(path).toBe('/reviews');
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const review of (body as { reviews: ReviewInput[] }).reviews) {
      if (this.logs.has(review._id)) {
        duplicates.push(review._id);
      } else {
        accepted.push(review._id);
        this.clock += 1000;
        this.logs.set(review._id, {
          ...review,
          storedAt: new Date(this.clock).toISOString(),
        });
      }
    }
    return {
      accepted,
      duplicates,
      cards: {},
    } satisfies PostReviewsResponse as T;
  }

  async get<T>(path: string): Promise<T> {
    if (this.offline) throw new TypeError('Failed to fetch');
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    const since = query.get('since') ?? '';
    const after = query.get('after');
    const sorted = [...this.logs.values()]
      .filter((r) =>
        after
          ? r.storedAt > since || (r.storedAt === since && r._id > after)
          : r.storedAt >= since,
      )
      .sort(
        (a, b) =>
          a.storedAt.localeCompare(b.storedAt) || a._id.localeCompare(b._id),
      );
    const page = sorted.slice(0, this.pageSize);
    const last = page.at(-1);
    return {
      reviews: page,
      next:
        sorted.length > this.pageSize && last
          ? { since: last.storedAt, after: last._id }
          : null,
    } satisfies GetReviewsResponse as T;
  }
}

let n = 0;
const review = (): ReviewInput => ({
  _id: crypto.randomUUID(),
  cardKey: `word:hsk30-0000${(n++ % 9) + 1}:pinyin`,
  rating: 3,
  reviewedAt: new Date().toISOString(),
});

const opened: LocalStore[] = [];
async function device(user = 'user-1', name = crypto.randomUUID()) {
  // Each simulated device gets its own database.
  const store = await LocalStore.open(`${user}-${name}`);
  opened.push(store);
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

describe('LocalStore', () => {
  it('keeps logs across reopening, with unsynced ones indexed', async () => {
    const id = crypto.randomUUID();
    const store = await LocalStore.open(id);
    const log = review();
    await store.addLog(log);
    store.close();

    const reopened = await LocalStore.open(id);
    opened.push(reopened);
    expect(await reopened.allLogs()).toEqual([{ ...log, synced: 0 }]);
    expect(await reopened.countUnsynced()).toBe(1);
    await reopened.markSynced([log._id]);
    expect(await reopened.countUnsynced()).toBe(0);
  });

  it('refuses to record the same log ID twice', async () => {
    const store = await device();
    const log = review();
    await store.addLog(log);
    await expect(store.addLog(log)).rejects.toThrow();
  });
});

describe('Sync', () => {
  it('pushes local logs and marks them synced', async () => {
    const server = new FakeServer();
    const store = await device();
    for (let i = 0; i < 3; i++) await store.addLog(review());

    const sync = new Sync(store, server);
    await sync.sync();
    expect(server.logs.size).toBe(3);
    expect(sync.status).toMatchObject({ state: 'idle', unsynced: 0 });
  });

  it('keeps logs on the device while offline and sends them later', async () => {
    const server = new FakeServer();
    server.offline = true;
    const store = await device();
    const sync = new Sync(store, server);
    await store.addLog(review());
    await sync.sync();
    expect(sync.status).toMatchObject({ state: 'offline', unsynced: 1 });

    server.offline = false;
    await sync.sync();
    expect(sync.status).toMatchObject({ state: 'idle', unsynced: 0 });
    expect(server.logs.size).toBe(1);
  });

  it('converges two devices to the same set of logs', async () => {
    const server = new FakeServer();
    const [phone, laptop] = [await device(), await device()];
    const phoneSync = new Sync(phone, server);
    const laptopSync = new Sync(laptop, server);
    let laptopChanged = 0;
    laptopSync.onChange(() => laptopChanged++);

    for (let i = 0; i < 5; i++) await phone.addLog(review());
    for (let i = 0; i < 2; i++) await laptop.addLog(review());
    await phoneSync.sync();
    await laptopSync.sync(); // pulls the phone's 5 (paged, 2 at a time)
    await phoneSync.sync(); // pulls the laptop's 2

    const ids = async (store: LocalStore) =>
      (await store.allLogs()).map((l) => [l._id, l.synced]).sort();
    expect(await ids(phone)).toEqual(await ids(laptop));
    expect((await phone.allLogs()).length).toBe(7);
    expect(await phone.countUnsynced()).toBe(0);
    expect(laptopChanged).toBe(1);

    // Nothing new: a sync changes nothing and fires no change event.
    await laptopSync.sync();
    expect(laptopChanged).toBe(1);
  });

  it('re-reads an overlap window so late-committed logs are not missed', async () => {
    const server = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.addLog(review());
    await new Sync(a, server).sync();
    const bSync = new Sync(b, server);
    await bSync.sync();

    // A log that committed with a storedAt just before B's cursor.
    const late = { ...review(), storedAt: '' };
    const newest = [...server.logs.values()].at(-1)!.storedAt;
    late.storedAt = new Date(Date.parse(newest) - 30_000).toISOString();
    server.logs.set(late._id, late);

    await bSync.sync();
    expect((await b.allLogs()).map((l) => l._id)).toContain(late._id);
  });

  it('folds overlapping sync calls into one more run', async () => {
    const server = new FakeServer();
    const store = await device();
    const sync = new Sync(store, server);
    let posts = 0;
    const post = server.post.bind(server);
    server.post = async (path, body) => {
      posts++;
      return post(path, body);
    };
    await store.addLog(review());
    const first = sync.sync();
    await store.addLog(review());
    void sync.sync();
    void sync.sync();
    await first;
    expect(server.logs.size).toBe(2);
    expect(posts).toBeLessThanOrEqual(2);
  });

  it('still pulls when the server refuses a push', async () => {
    const server = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.addLog(review());
    await new Sync(a, server).sync();

    await b.addLog(review());
    server.post = async () => {
      throw new ApiError('Unknown word in cardKey', 400);
    };
    const sync = new Sync(b, server);
    await sync.sync();
    expect(sync.status).toMatchObject({
      state: 'error',
      unsynced: 1,
      errorStatus: 400,
    });
    expect((await b.allLogs()).length).toBe(2);
  });
});

describe('loadContent', () => {
  const word = (n: number, level: 1 | 2): WordNote =>
    ({ _id: `w${n}`, level, levelOrder: n }) as WordNote;
  const dataset = (hash: string) => ({
    version: '1',
    contentHash: hash,
    levelCounts: { 1: 2, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
  });

  function api(hash = 'h1') {
    const calls: string[] = [];
    let offline = false;
    return {
      calls,
      setOffline: (value: boolean) => {
        offline = value;
      },
      async get<T>(path: string): Promise<T> {
        if (offline) throw new TypeError('Failed to fetch');
        calls.push(path);
        if (path === '/dataset') return dataset(hash) as T;
        const level = Number(path.split('level=')[1]);
        return {
          words: [word(1, 1), word(2, 1), word(3, 2)].filter(
            (w) => w.level === level,
          ),
        } as T;
      },
      async post<T>(path: string, body: unknown): Promise<T> {
        calls.push(path);
        const { ids } = body as { ids: string[] };
        return {
          words: [word(3, 2)].filter((w) => ids.includes(w._id)),
        } as T;
      },
    };
  }

  it('downloads enabled levels and started words once, then works offline', async () => {
    const store = await device();
    const server = api();
    const first = await loadContent(store, [1], ['w3'], { api: server });
    expect([...first.words.keys()].sort()).toEqual(['w1', 'w2', 'w3']);
    expect(server.calls).toEqual([
      '/dataset',
      '/words?level=1',
      '/words/lookup',
    ]);

    server.calls.length = 0;
    await loadContent(store, [1], ['w3'], { api: server });
    expect(server.calls).toEqual(['/dataset']);
    server.calls.length = 0;
    await loadContent(store, [1], ['w3'], {
      api: server,
      checkDataset: false,
    });
    expect(server.calls).toEqual([]);

    server.setOffline(true);
    const offline = await loadContent(store, [1, 2], ['w3'], { api: server });
    expect(offline.offline).toBe(true);
    expect(offline.words.size).toBe(3);
    expect(offline.dataset?.contentHash).toBe('h1');
  });

  it('drops the cache when the dataset changes', async () => {
    const store = await device();
    await loadContent(store, [1], [], { api: api('h1') });
    const server = api('h2');
    await loadContent(store, [1], [], { api: server });
    expect(server.calls).toEqual(['/dataset', '/words?level=1']);
  });
});

describe('upgrading the local database', () => {
  it('keeps version 1 logs and adds the characters store', async () => {
    const user = crypto.randomUUID();
    const log = review();
    // A database as the version 1 client left it.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`hanyu-${user}`, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('logs', { keyPath: '_id' }).createIndex(
          'synced',
          'synced',
        );
        db.createObjectStore('words', { keyPath: '_id' }).createIndex(
          'level',
          'level',
        );
        db.createObjectStore('meta');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('logs', 'readwrite');
        tx.objectStore('logs').add({ ...log, synced: 0 });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
      request.onerror = () => reject(request.error);
    });

    const store = await LocalStore.open(user);
    opened.push(store);
    expect(await store.allLogs()).toEqual([{ ...log, synced: 0 }]);
    await store.putCharacters([
      { _id: '十', strokes: [], medians: [] } as unknown as CharacterContent,
    ]);
    expect([...(await store.allCharacters()).keys()]).toEqual(['十']);
  });
});

describe('loadCharacters', () => {
  it('downloads missing characters once and works offline', async () => {
    const store = await device();
    const requested: string[][] = [];
    let offline = false;
    const api = {
      get: async () => {
        throw new Error('unused');
      },
      async post<T>(_path: string, body: unknown): Promise<T> {
        if (offline) throw new TypeError('Failed to fetch');
        const { ids } = body as { ids: string[] };
        requested.push(ids);
        return {
          characters: ids
            .filter((id) => id !== '鬱')
            .map((id) => ({ _id: id, strokes: [], medians: [] })),
        } as T;
      },
    };

    const first = await loadCharacters(store, ['十', '口', '十', '鬱'], api);
    expect([...first.keys()].sort()).toEqual(['十', '口']);
    expect(requested).toEqual([['十', '口', '鬱']]);

    await loadCharacters(store, ['十', '口'], api);
    expect(requested).toHaveLength(1);

    offline = true;
    const cached = await loadCharacters(store, ['十', '人'], api);
    expect([...cached.keys()].sort()).toEqual(['十', '口']);
  });
});
