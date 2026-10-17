// The seed content passage generation works from: words, grammar points, and
// which characters have stroke data (for handwritten cloze answers).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CharacterStrokes,
  GrammarPoint,
  HskLevel,
  WordNote,
} from '@hanyu/shared';
import { seedDir } from '../paths.js';

export interface SeedContent {
  words: WordNote[];
  grammar: GrammarPoint[];
  /** Each HSK word's lowest level. */
  wordLevels: Map<string, HskLevel>;
  /** Characters with Make Me a Hanzi stroke data. */
  writable: Set<string>;
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(path.join(seedDir, file), 'utf8')) as T;

export function loadSeedContent(): SeedContent {
  const words = read<WordNote[]>('words.json');
  const grammar = read<GrammarPoint[]>('grammar.json');
  const strokes = read<CharacterStrokes[]>('strokes.json');
  const wordLevels = new Map<string, HskLevel>();
  for (const word of words) {
    const current = wordLevels.get(word.simplified);
    if (current === undefined || word.level < current) {
      wordLevels.set(word.simplified, word.level);
    }
  }
  return {
    words,
    grammar,
    wordLevels,
    writable: new Set(
      strokes.filter((s) => s.strokes.length > 0).map((s) => s._id),
    ),
  };
}
