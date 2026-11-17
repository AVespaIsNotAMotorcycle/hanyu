// The Translate library on disk: data/translate/hsk<level>/<id>.json, one
// file per exercise so each can be reviewed (and rejected) in git.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { HskLevel, TranslateExercise } from '@hanyu/shared';
import { dataDir } from '../paths.js';

export const translateDir = path.join(dataDir, 'translate');

const levelDir = (root: string, level: HskLevel) =>
  path.join(root, `hsk${level}`);

export function readExercises(
  level: HskLevel,
  root: string = translateDir,
): TranslateExercise[] {
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
        ) as TranslateExercise,
    );
}

export const exerciseFile = (
  exercise: TranslateExercise,
  root: string = translateDir,
) => path.join(levelDir(root, exercise.level), `${exercise._id}.json`);

/** Fields in a fixed order, so files written by different commands diff cleanly. */
function canonical(exercise: TranslateExercise): TranslateExercise {
  return {
    _id: exercise._id,
    level: exercise.level,
    english: exercise.english,
    reference: exercise.reference,
    topic: exercise.topic,
    tokens: exercise.tokens,
    grammar: exercise.grammar,
    verification: exercise.verification,
    answerKeyCheck: exercise.answerKeyCheck ?? null,
    review: exercise.review ?? null,
    generation: exercise.generation,
  };
}

export function writeExercise(
  exercise: TranslateExercise,
  root: string = translateDir,
) {
  const file = exerciseFile(exercise, root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(canonical(exercise), null, 2)}\n`);
  return file;
}

export function deleteExercise(
  exercise: TranslateExercise,
  root: string = translateDir,
) {
  const file = exerciseFile(exercise, root);
  rmSync(file);
  return file;
}
