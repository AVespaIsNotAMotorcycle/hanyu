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
  /** Characters per level they're introduced at (`introLevel`). */
  characterLevelCounts: Record<HskLevel, number>;
}

/** GET /api/words?level=N, and POST /api/words/lookup. */
export interface WordsResponse {
  words: WordNote[];
}

/** POST /api/words/lookup: words by ID (for started cards outside cached levels). */
export interface WordLookupRequest {
  ids: string[];
}

/** Most IDs per POST /api/characters/lookup. */
export const MAX_CHARACTER_LOOKUP = 500;

/**
 * What a handwriting card needs about a character. `strokes` and `medians`
 * come from Make Me a Hanzi's graphics.txt (Arphic Public License).
 */
export interface CharacterContent {
  _id: string;
  traditional: string[];
  /** Citation readings with tone numbers (`xue2`). */
  readings: string[];
  introLevel: HskLevel;
  definition: string | null;
  /** SVG path per stroke, in Make Me a Hanzi's 1024-unit coordinates. */
  strokes: string[];
  /** Each stroke's median line, as [x, y] points. */
  medians: [number, number][][];
}

/** POST /api/characters/lookup. */
export interface CharactersResponse {
  characters: CharacterContent[];
}

export interface CharacterLookupRequest {
  ids: string[];
}
