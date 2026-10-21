// The listening library on disk: data/listening/hsk<level>/<id>.json, one
// file per exercise so each can be reviewed (and rejected) in git.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { HskLevel, ListeningExercise } from '@hanyu/shared';
import { dataDir } from '../paths.js';

export const listeningDir = path.join(dataDir, 'listening');

const levelDir = (root: string, level: HskLevel) =>
  path.join(root, `hsk${level}`);

export function readExercises(
  level: HskLevel,
  root: string = listeningDir,
): ListeningExercise[] {
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
        ) as ListeningExercise,
    );
}

export const exerciseFile = (
  exercise: ListeningExercise,
  root: string = listeningDir,
) => path.join(levelDir(root, exercise.level), `${exercise._id}.json`);

/** Fields in a fixed order, so files written by different commands diff cleanly. */
function canonical(exercise: ListeningExercise): ListeningExercise {
  return {
    _id: exercise._id,
    level: exercise.level,
    text: exercise.text,
    textEnglish: exercise.textEnglish,
    topic: exercise.topic,
    names: exercise.names,
    grammar: exercise.grammar,
    questions: exercise.questions,
    verification: exercise.verification,
    answerKeyCheck: exercise.answerKeyCheck ?? null,
    review: exercise.review ?? null,
    generation: exercise.generation,
  };
}

export function writeExercise(
  exercise: ListeningExercise,
  root: string = listeningDir,
) {
  const file = exerciseFile(exercise, root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(canonical(exercise), null, 2)}\n`);
  return file;
}

export function deleteExercise(
  exercise: ListeningExercise,
  root: string = listeningDir,
) {
  const file = exerciseFile(exercise, root);
  rmSync(file);
  return file;
}
