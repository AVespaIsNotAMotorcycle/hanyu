// The passage library on disk: data/passages/hsk<level>/<id>.json, one file
// per passage so each can be reviewed (and rejected) in git.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { GrammarPoint, HskLevel, Passage } from '@hanyu/shared';
import { dataDir } from '../paths.js';

export const passagesDir = path.join(dataDir, 'passages');

const levelDir = (root: string, level: HskLevel) =>
  path.join(root, `hsk${level}`);

export function readPassages(
  level: HskLevel,
  root: string = passagesDir,
): Passage[] {
  let files: string[];
  try {
    files = readdirSync(levelDir(root, level));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(
      (f) =>
        JSON.parse(
          readFileSync(path.join(levelDir(root, level), f), 'utf8'),
        ) as Passage,
    );
}

/** The next free ID at a level: p1-0001, p1-0002, … */
export function nextPassageId(existing: readonly Passage[], level: HskLevel) {
  const used = existing
    .map((p) => Number(p._id.split('-')[1]))
    .filter(Number.isFinite);
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `p${level}-${String(n).padStart(4, '0')}`;
}

export const passageFile = (passage: Passage, root: string = passagesDir) =>
  path.join(levelDir(root, passage.level), `${passage._id}.json`);

/**
 * Fields in a fixed order, so files written by different commands diff
 * cleanly. Fields older files lack are filled in as null.
 */
function canonical(passage: Passage): Passage {
  return {
    _id: passage._id,
    level: passage.level,
    title: passage.title,
    titleEnglish: passage.titleEnglish,
    text: passage.text,
    names: passage.names,
    grammar: passage.grammar,
    questions: passage.questions,
    tokens: passage.tokens,
    translation: passage.translation ?? null,
    verification: passage.verification,
    answerKeyCheck: passage.answerKeyCheck ?? null,
    review: passage.review ?? null,
    generation: passage.generation,
  };
}

export function writePassage(passage: Passage, root: string = passagesDir) {
  const file = passageFile(passage, root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(canonical(passage), null, 2)}\n`);
  return file;
}

export function deletePassage(passage: Passage, root: string = passagesDir) {
  const file = passageFile(passage, root);
  rmSync(file);
  return file;
}

/**
 * Up to `n` passages to spot-check by hand: chosen at random among those
 * that passed the answer-key check and haven't been reviewed.
 */
export function pickSample(
  passages: readonly Passage[],
  n: number,
  random: () => number = Math.random,
): Passage[] {
  const pool = passages.filter((p) => p.answerKeyCheck?.passed && !p.review);
  // Fisher–Yates, stopping once n are drawn.
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

export interface LibraryStatus {
  passages: number;
  /** Passed the answer-key check (current prompt version or not). */
  checked: number;
  /** Failed it: regenerate or delete these. */
  failed: number;
  /** Spot-checked by hand. */
  reviewed: number;
}

export function libraryStatus(passages: readonly Passage[]): LibraryStatus {
  return {
    passages: passages.length,
    checked: passages.filter((p) => p.answerKeyCheck?.passed).length,
    failed: passages.filter((p) => p.answerKeyCheck?.passed === false).length,
    reviewed: passages.filter((p) => p.review).length,
  };
}

export interface Coverage {
  point: GrammarPoint;
  /** Passages that exercise it. */
  passages: number;
}

/** How many passages exercise each of a level's grammar points, least covered first. */
export function grammarCoverage(
  grammar: readonly GrammarPoint[],
  passages: readonly Passage[],
  level: HskLevel,
): Coverage[] {
  const counts = new Map<string, number>();
  for (const passage of passages) {
    for (const id of new Set(passage.grammar.map((g) => g.grammarId))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return grammar
    .filter((g) => g.level === level)
    .map((point) => ({ point, passages: counts.get(point._id) ?? 0 }))
    .sort((a, b) => a.passages - b.passages || a.point.order - b.point.order);
}
