// Level verification: what share of a passage a learner at a given HSK level
// already has the words for.

import type { HskLevel, LevelCheck } from '@hanyu/shared';
import { isHanziToken, type Segmenter } from '../segmenter.js';

/** Longest HSK word, bounding the split search. */
const MAX_WORD_LENGTH = 8;

/**
 * Whether a token is known at a level: it's an HSK word at or below the
 * level, a declared name, or it splits entirely into such words (jieba
 * sometimes groups HSK words into a larger compound: 吹口哨 = 吹 + 口哨).
 */
function isKnown(
  token: string,
  known: (word: string) => boolean,
  memo = new Map<string, boolean>(),
): boolean {
  if (known(token)) return true;
  const cached = memo.get(token);
  if (cached !== undefined) return cached;
  let result = false;
  const chars = [...token];
  for (let i = Math.min(chars.length - 1, MAX_WORD_LENGTH); i >= 1; i--) {
    const head = chars.slice(0, i).join('');
    if (known(head) && isKnown(chars.slice(i).join(''), known, memo)) {
      result = true;
      break;
    }
  }
  memo.set(token, result);
  return result;
}

/**
 * The parts of an unknown token to report: known words are peeled off the
 * front greedily (longest first), leaving runs of unknown characters
 * (喝咖啡 at HSK 1 → 咖啡).
 */
function unknownParts(token: string, known: (word: string) => boolean) {
  const chars = [...token];
  const parts: string[] = [];
  let run = '';
  let i = 0;
  while (i < chars.length) {
    let matched = 0;
    for (let n = Math.min(chars.length - i, MAX_WORD_LENGTH); n >= 1; n--) {
      if (known(chars.slice(i, i + n).join(''))) {
        matched = n;
        break;
      }
    }
    if (matched) {
      if (run) parts.push(run);
      run = '';
      i += matched;
    } else {
      run += chars[i++];
    }
  }
  if (run) parts.push(run);
  return parts.length ? parts : [token];
}

/**
 * Segments a passage and counts the hanzi tokens a learner at `level` knows.
 * Punctuation, digits, and Latin text are not counted.
 */
export function checkLevel(
  text: string,
  level: HskLevel,
  {
    segmenter,
    wordLevels,
    names = [],
  }: {
    segmenter: Segmenter;
    /** Each HSK word's level (the lowest, for words listed at several). */
    wordLevels: ReadonlyMap<string, HskLevel>;
    names?: readonly string[];
  },
): LevelCheck {
  const nameSet = new Set(names);
  const known = (word: string) =>
    nameSet.has(word) || (wordLevels.get(word) ?? Infinity) <= level;
  const tokens = segmenter.segment(text).filter(isHanziToken);
  const memo = new Map<string, boolean>();
  const offLevel = new Set<string>();
  let atOrBelowLevel = 0;
  for (const token of tokens) {
    if (isKnown(token, known, memo)) atOrBelowLevel++;
    else for (const part of unknownParts(token, known)) offLevel.add(part);
  }
  return {
    tokens: tokens.length,
    atOrBelowLevel,
    share: tokens.length ? atOrBelowLevel / tokens.length : 0,
    offLevel: [...offLevel],
  };
}
