// Keeps the word content the queue needs in IndexedDB: every word in the
// enabled levels, plus the word of every started card. Works offline with
// whatever is already cached.

import {
  MAX_WORD_LOOKUP,
  type DatasetResponse,
  type HskLevel,
  type WordNote,
  type WordsResponse,
} from '@hanyu/shared';
import { ApiError, getJson, postJson } from '../api';
import type { LocalStore } from './store';

export interface ContentApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

const DATASET = 'dataset';
const CACHED_LEVELS = 'cachedLevels';

export interface Content {
  words: Map<string, WordNote>;
  /** Null until the dataset has been fetched once. */
  dataset: DatasetResponse | null;
  /** True if the server couldn't be reached and cached content was used. */
  offline: boolean;
}

/**
 * Makes sure the levels in `levels` and the words in `wordIds` are cached,
 * downloading what's missing. A changed dataset (new seed) drops the cache.
 */
export async function loadContent(
  store: LocalStore,
  levels: readonly HskLevel[],
  wordIds: Iterable<string>,
  {
    checkDataset = true,
    api = { get: getJson, post: postJson },
  }: {
    /** Ask the server whether the dataset changed (once per page load is plenty). */
    checkDataset?: boolean;
    api?: ContentApi;
  } = {},
): Promise<Content> {
  let dataset = (await store.getMeta<DatasetResponse>(DATASET)) ?? null;
  let words = await store.allWords();
  try {
    if (checkDataset || !dataset) {
      const current = await api.get<DatasetResponse>('/dataset');
      if (current.contentHash !== dataset?.contentHash) {
        await store.clearWords();
        await store.setMeta(CACHED_LEVELS, []);
        words = new Map();
      }
      await store.setMeta(DATASET, current);
      dataset = current;
    }

    const cached = new Set(
      (await store.getMeta<HskLevel[]>(CACHED_LEVELS)) ?? [],
    );
    for (const level of levels) {
      if (cached.has(level)) continue;
      const page = await api.get<WordsResponse>(`/words?level=${level}`);
      await store.putWords(page.words);
      for (const word of page.words) words.set(word._id, word);
      cached.add(level);
      await store.setMeta(CACHED_LEVELS, [...cached]);
    }

    const missing = [...new Set(wordIds)].filter((id) => !words.has(id));
    for (let i = 0; i < missing.length; i += MAX_WORD_LOOKUP) {
      const page = await api.post<WordsResponse>('/words/lookup', {
        ids: missing.slice(i, i + MAX_WORD_LOOKUP),
      });
      await store.putWords(page.words);
      for (const word of page.words) words.set(word._id, word);
    }
    return { words, dataset, offline: false };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Offline: study with whatever is cached.
    return { words, dataset, offline: true };
  }
}
