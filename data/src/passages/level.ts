// Level verification: what share of a passage a learner at a given HSK level
// already has the words for.

import { paragraphs, type HskLevel, type LevelCheck } from '@hanyu/shared';
import { isHanziToken, type Segmenter } from '../segmenter.js';

/** Longest HSK word, bounding the split search. */
const MAX_WORD_LENGTH = 8;

/**
 * Splits a token into known words, longest first, or returns null if it
 * can't be. A known token comes back whole; jieba sometimes groups HSK words
 * into a larger compound (吹口哨 = 吹 + 口哨).
 */
function splitKnown(
  token: string,
  known: (word: string) => boolean,
  memo = new Map<string, string[] | null>(),
): string[] | null {
  if (known(token)) return [token];
  const cached = memo.get(token);
  if (cached !== undefined) return cached;
  let result: string[] | null = null;
  const chars = [...token];
  for (let i = Math.min(chars.length - 1, MAX_WORD_LENGTH); i >= 1; i--) {
    const head = chars.slice(0, i).join('');
    if (!known(head)) continue;
    const rest = splitKnown(chars.slice(i).join(''), known, memo);
    if (rest) {
      result = [head, ...rest];
      break;
    }
  }
  memo.set(token, result);
  return result;
}

/**
 * Whether a token is known at a level: it's an HSK word at or below the
 * level, a declared name, or it splits entirely into such words.
 */
function isKnown(
  token: string,
  known: (word: string) => boolean,
  memo = new Map<string, string[] | null>(),
): boolean {
  return splitKnown(token, known, memo) !== null;
}

/**
 * Known words peeled off the front greedily (longest first), and the runs of
 * unknown characters between them (喝咖啡 at HSK 1 → 喝, 咖啡).
 */
function greedyParts(token: string, known: (word: string) => boolean) {
  const chars = [...token];
  const parts: { text: string; known: boolean }[] = [];
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
      if (run) parts.push({ text: run, known: false });
      run = '';
      parts.push({ text: chars.slice(i, i + matched).join(''), known: true });
      i += matched;
    } else {
      run += chars[i++];
    }
  }
  if (run) parts.push({ text: run, known: false });
  return parts;
}

/** The parts of an unknown token to report (喝咖啡 at HSK 1 → 咖啡). */
function unknownParts(token: string, known: (word: string) => boolean) {
  const parts = greedyParts(token, known)
    .filter((p) => !p.known)
    .map((p) => p.text);
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
  const memo = new Map<string, string[] | null>();
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

/**
 * Splits a jieba token for lookup into HSK words or names, in as few pieces
 * as possible: 喝咖啡 → 喝 + 咖啡, 两本书 → 两 + 本 + 书. Other words jieba
 * knows (two characters or more) fill gaps only where HSK words can't. A
 * token that can't be split that way stays whole (博物馆).
 */
const NON_HSK_PIECE_COST = 100;

function lookupPieces(
  token: string,
  known: (word: string) => boolean,
  inDictionary: (word: string) => boolean,
): string[] {
  if (known(token)) return [token];
  const chars = [...token];
  // best[i]: the cheapest split of the first i characters.
  const best: ({ cost: number; pieces: string[] } | null)[] = [
    { cost: 0, pieces: [] },
  ];
  for (let end = 1; end <= chars.length; end++) {
    best[end] = null;
    for (let n = 1; n <= Math.min(end, MAX_WORD_LENGTH); n++) {
      const before = best[end - n];
      if (!before) continue;
      const piece = chars.slice(end - n, end).join('');
      const cost = known(piece)
        ? 1
        : n >= 2 && piece !== token && inDictionary(piece)
          ? NON_HSK_PIECE_COST
          : null;
      if (cost === null) continue;
      if (!best[end] || before.cost + cost < best[end]!.cost) {
        best[end] = {
          cost: before.cost + cost,
          pieces: [...before.pieces, piece],
        };
      }
    }
  }
  return best[chars.length]?.pieces ?? [token];
}

/**
 * Segments a passage for tap-to-look-up: one token list per paragraph, each
 * joining back into the paragraph. Hanzi tokens are split into HSK words
 * (any level) or names where possible (see lookupPieces).
 */
export function tokenize(
  text: string,
  {
    segmenter,
    wordLevels,
    names = [],
  }: {
    segmenter: Segmenter;
    wordLevels: ReadonlyMap<string, HskLevel>;
    names?: readonly string[];
  },
): string[][] {
  const nameSet = new Set(names);
  const known = (word: string) => nameSet.has(word) || wordLevels.has(word);
  const inDictionary = (word: string) => segmenter.has(word);
  return paragraphs(text).map((paragraph) =>
    mergeAcrossNames(segmenter.cut(paragraph), paragraph, names).flatMap(
      (token) =>
        isHanziToken(token)
          ? lookupPieces(token, known, inDictionary)
          : [token],
    ),
  );
}

/**
 * Joins tokens that a name straddles, so splitting them again can find the
 * name: jieba cuts 小明说 into 小 + 明说 ("say openly").
 */
function mergeAcrossNames(
  tokens: string[],
  text: string,
  names: readonly string[],
): string[] {
  // Offsets (UTF-16, like indexOf) inside a name, where no token may start.
  const inside = new Set<number>();
  for (const name of names) {
    for (
      let at = text.indexOf(name);
      at >= 0;
      at = text.indexOf(name, at + 1)
    ) {
      for (let i = at + 1; i < at + name.length; i++) inside.add(i);
    }
  }
  const merged: string[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (inside.has(offset) && merged.length) merged[merged.length - 1] += token;
    else merged.push(token);
    offset += token.length;
  }
  return merged;
}
