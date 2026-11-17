// Eval files: data/grader-evals/learner.json (the learner-style set),
// results/<model>-v<prompt version>.json (one eval run per grader version),
// and consistency/<date>-<model>-v<version>.json (re-grading runs). The
// English → Chinese grader's files add `-en-zh`: learner-en-zh.json,
// results/<model>-en-zh-v<version>.json, and so on.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TranslationDirection } from '@hanyu/shared';
import { dataDir } from '../paths.js';
import type { LearnerItem } from './learnerSet.js';
import type {
  calibrationMetrics,
  CalibrationOutcome,
  learnerMetrics,
  LearnerOutcome,
} from './metrics.js';

export const evalsDir = path.join(dataDir, 'grader-evals');
/** '' for Chinese → English (the original files), '-en-zh' otherwise. */
const suffix = (direction: TranslationDirection = 'zh-en') =>
  direction === 'zh-en' ? '' : `-${direction}`;

export const learnerSetPath = (direction?: TranslationDirection) =>
  path.join(evalsDir, `learner${suffix(direction)}.json`);
export const learnerSetFile = learnerSetPath('zh-en');

export interface EvalResults {
  model: string;
  /** Absent in Chinese → English results. */
  direction?: TranslationDirection;
  promptVersion: string;
  ranAt: string;
  costUsd: number;
  /** MQM calibration: Chinese → English only. */
  calibration: ReturnType<typeof calibrationMetrics> | null;
  learner: ReturnType<typeof learnerMetrics>;
  /** Calibration items: IDs and numbers only (the TED text isn't republished). */
  calibrationItems: CalibrationOutcome[];
  learnerItems: LearnerOutcome[];
}

export const resultsFile = (
  model: string,
  promptVersion: string,
  root = evalsDir,
  direction?: TranslationDirection,
) =>
  path.join(
    root,
    'results',
    `${model}${suffix(direction)}-v${promptVersion}.json`,
  );

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
  direction?: TranslationDirection,
): EvalResults | null {
  try {
    return JSON.parse(
      readFileSync(resultsFile(model, promptVersion, root, direction), 'utf8'),
    ) as EvalResults;
  } catch {
    return null;
  }
}

export function writeResults(results: EvalResults, root = evalsDir) {
  return writeJson(
    resultsFile(results.model, results.promptVersion, root, results.direction),
    results,
  );
}

export interface ConsistencyRun {
  model: string;
  direction?: TranslationDirection;
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
      `${run.ranAt.slice(0, 10)}-${run.model}${suffix(run.direction)}-v${run.promptVersion}.json`,
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
