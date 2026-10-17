// Word content for the client's offline cache.

import type { HskLevel, WordNote } from './content.js';

/** Most IDs per POST /api/words/lookup. */
export const MAX_WORD_LOOKUP = 1000;

/** GET /api/dataset: which dataset is loaded, so clients can drop stale caches. */
export interface DatasetResponse {
  version: string;
  contentHash: string;
  /** Words per level. */
  levelCounts: Record<HskLevel, number>;
}

/** GET /api/words?level=N, and POST /api/words/lookup. */
export interface WordsResponse {
  words: WordNote[];
}

/** POST /api/words/lookup: words by ID (for started cards outside cached levels). */
export interface WordLookupRequest {
  ids: string[];
}
