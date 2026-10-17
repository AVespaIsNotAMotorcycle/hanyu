// Eval files: data/grader-evals/learner.json (the learner-style set),
// results/<model>-v<prompt version>.json (one eval run per grader version),
// and consistency/<date>-<model>-v<version>.json (re-grading runs).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';
import type { LearnerItem } from './learnerSet.js';
import type {
  calibrationMetrics,
  CalibrationOutcome,
  learnerMetrics,
  LearnerOutcome,
} from './metrics.js';

export const evalsDir = path.join(dataDir, 'grader-evals');
export const learnerSetFile = path.join(evalsDir, 'learner.json');

export interface EvalResults {
  model: string;
  promptVersion: string;
  ranAt: string;
  costUsd: number;
  calibration: ReturnType<typeof calibrationMetrics>;
  learner: ReturnType<typeof learnerMetrics>;
  /** Calibration items: IDs and numbers only (the TED text isn't republished). */
  calibrationItems: CalibrationOutcome[];
  learnerItems: LearnerOutcome[];
}

export const resultsFile = (
  model: string,
  promptVersion: string,
  root = evalsDir,
) => path.join(root, 'results', `${model}-v${promptVersion}.json`);

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export function readLearnerSet(file = learnerSetFile): LearnerItem[] {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LearnerItem[];
  } catch {
    return [];
  }
}

export function writeLearnerSet(
  items: readonly LearnerItem[],
  file = learnerSetFile,
) {
  return writeJson(
    file,
    [...items].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function readResults(
  model: string,
  promptVersion: string,
  root = evalsDir,
): EvalResults | null {
  try {
    return JSON.parse(
      readFileSync(resultsFile(model, promptVersion, root), 'utf8'),
    ) as EvalResults;
  } catch {
    return null;
  }
}

export function writeResults(results: EvalResults, root = evalsDir) {
  return writeJson(
    resultsFile(results.model, results.promptVersion, root),
    results,
  );
}

export interface ConsistencyRun {
  model: string;
  promptVersion: string;
  ranAt: string;
  costUsd: number;
  /** Mean absolute change in overall score from the eval run. */
  meanOverallChange: number | null;
  items: {
    id: string;
    overall: number;
    before: number;
    graderPenalty: number;
    penaltyBefore: number;
  }[];
}

export function writeConsistency(run: ConsistencyRun, root = evalsDir) {
  return writeJson(
    path.join(
      root,
      'consistency',
      `${run.ranAt.slice(0, 10)}-${run.model}-v${run.promptVersion}.json`,
    ),
    run,
  );
}

export function consistencyRuns(root = evalsDir): string[] {
  try {
    return readdirSync(path.join(root, 'consistency'))
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}
