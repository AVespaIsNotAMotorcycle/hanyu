// The browser's copy of a user's data, in IndexedDB: review logs (the source
// of truth for card state, synced with the server) and cached word content.
// One database per user, so accounts on a shared browser stay separate.

import type {
  CharacterContent,
  ReviewInput,
  StoredReview,
  WordNote,
} from '@hanyu/shared';

/** A log as kept locally. `synced` is 0/1 because IndexedDB can't index booleans. */
export interface LocalLog extends ReviewInput {
  synced: 0 | 1;
}

// 1: logs, words, meta. 2: characters.
const VERSION = 2;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export const databaseName = (userId: string) => `hanyu-${userId}`;

export class LocalStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(userId: string): Promise<LocalStore> {
    const request = indexedDB.open(databaseName(userId), VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        const logs = db.createObjectStore('logs', { keyPath: '_id' });
        logs.createIndex('synced', 'synced');
        const words = db.createObjectStore('words', { keyPath: '_id' });
        words.createIndex('level', 'level');
        db.createObjectStore('meta');
      }
      if (event.oldVersion < 2) {
        db.createObjectStore('characters', { keyPath: '_id' });
      }
    };
    return new LocalStore(await promisify(request));
  }

  /** Deletes a user's local database (after sign-out). */
  static async destroy(userId: string): Promise<void> {
    await promisify(indexedDB.deleteDatabase(databaseName(userId)));
  }

  close() {
    this.db.close();
  }

  // --- Logs ---------------------------------------------------------------------

  /** Records a review made on this device; it syncs later. */
  async addLog(review: ReviewInput): Promise<void> {
    const tx = this.db.transaction('logs', 'readwrite');
    tx.objectStore('logs').add({ ...review, synced: 0 } satisfies LocalLog);
    await done(tx);
  }

  /** Stores logs from the server; existing ones (same ID) are marked synced. */
  async putServerLogs(reviews: readonly StoredReview[]): Promise<number> {
    const tx = this.db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    let added = 0;
    for (const { storedAt: _, ...review } of reviews) {
      const existing = store.get(review._id);
      existing.onsuccess = () => {
        if (!existing.result) added++;
        store.put({ ...review, synced: 1 } satisfies LocalLog);
      };
    }
    await done(tx);
    return added;
  }

  async markSynced(ids: readonly string[]): Promise<void> {
    const tx = this.db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) store.put({ ...request.result, synced: 1 });
      };
    }
    await done(tx);
  }

  async unsyncedLogs(limit: number): Promise<LocalLog[]> {
    const index = this.db
      .transaction('logs')
      .objectStore('logs')
      .index('synced');
    return promisify(index.getAll(0, limit)) as Promise<LocalLog[]>;
  }

  async countUnsynced(): Promise<number> {
    const index = this.db
      .transaction('logs')
      .objectStore('logs')
      .index('synced');
    return promisify(index.count(0));
  }

  async allLogs(): Promise<LocalLog[]> {
    return promisify(
      this.db.transaction('logs').objectStore('logs').getAll(),
    ) as Promise<LocalLog[]>;
  }

  // --- Words --------------------------------------------------------------------

  async putWords(words: readonly WordNote[]): Promise<void> {
    const tx = this.db.transaction('words', 'readwrite');
    const store = tx.objectStore('words');
    for (const word of words) store.put(word);
    await done(tx);
  }

  async allWords(): Promise<Map<string, WordNote>> {
    const words = (await promisify(
      this.db.transaction('words').objectStore('words').getAll(),
    )) as WordNote[];
    return new Map(words.map((w) => [w._id, w]));
  }

  // --- Characters (stroke data for handwriting cards) ------------------------

  async putCharacters(characters: readonly CharacterContent[]): Promise<void> {
    const tx = this.db.transaction('characters', 'readwrite');
    const store = tx.objectStore('characters');
    for (const character of characters) store.put(character);
    await done(tx);
  }

  async allCharacters(): Promise<Map<string, CharacterContent>> {
    const characters = (await promisify(
      this.db.transaction('characters').objectStore('characters').getAll(),
    )) as CharacterContent[];
    return new Map(characters.map((c) => [c._id, c]));
  }

  /** Drops cached words and characters (the dataset changed). */
  async clearContent(): Promise<void> {
    const tx = this.db.transaction(['words', 'characters'], 'readwrite');
    tx.objectStore('words').clear();
    tx.objectStore('characters').clear();
    await done(tx);
  }

  // --- Meta ---------------------------------------------------------------------

  async getMeta<T>(key: string): Promise<T | undefined> {
    return promisify(
      this.db.transaction('meta').objectStore('meta').get(key),
    ) as Promise<T | undefined>;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await done(tx);
  }
}
