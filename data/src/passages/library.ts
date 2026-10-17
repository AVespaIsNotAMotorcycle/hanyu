// The passage library on disk: data/passages/hsk<level>/<id>.json, one file
// per passage so each can be reviewed (and rejected) in git.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function writePassage(passage: Passage, root: string = passagesDir) {
  const dir = levelDir(root, passage.level);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${passage._id}.json`);
  writeFileSync(file, `${JSON.stringify(passage, null, 2)}\n`);
  return file;
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
