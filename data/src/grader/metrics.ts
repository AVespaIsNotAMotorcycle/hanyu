// Scoring the grader against the eval sets.

import {
  errorPenalty,
  findSpan,
  overallScore,
  type GradingResult,
  type TranslationError,
} from '@hanyu/shared';
import type { InjectedError, LearnerItem } from './learnerSet.js';
import type { CalibrationItem } from './mqm.js';

/** Spearman rank correlation (average ranks for ties). Null if undefined. */
export function spearman(
  xs: readonly number[],
  ys: readonly number[],
): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (values: readonly number[]) => {
    const order = values
      .map((v, i) => [v, i] as const)
      .sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(values.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) ranks[order[k]![1]] = (i + j) / 2;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mean = (r: number[]) => r.reduce((a, b) => a + b, 0) / r.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const overlaps = (a: [number, number], b: [number, number]) =>
  a[0] < b[1] && b[0] < a[1];

/** A grader error's span in the translation and in the source, if located. */
function graderRanges(error: TranslationError) {
  return {
    translation:
      error.translationStart === null
        ? null
        : ([
            error.translationStart,
            error.translationStart + error.translationSpan.trim().length,
          ] as [number, number]),
    source:
      error.sourceStart === null
        ? null
        : ([
            error.sourceStart,
            error.sourceStart + error.sourceSpan.trim().length,
          ] as [number, number]),
  };
}

/** Whether any grader error covers an expected error, by translation or source span. */
function found(
  expected: {
    translation: [number, number] | null;
    source: [number, number] | null;
  },
  errors: readonly TranslationError[],
): boolean {
  return errors.some((error) => {
    const got = graderRanges(error);
    return (
      (expected.translation !== null &&
        got.translation !== null &&
        overlaps(expected.translation, got.translation)) ||
      (expected.source !== null &&
        got.source !== null &&
        overlaps(expected.source, got.source))
    );
  });
}

export interface CalibrationOutcome {
  id: string;
  mqmPenalty: number;
  graderPenalty: number;
  overall: number;
  /** MQM major errors located in the text, and how many the grader covered. */
  majorSpans: number;
  majorFound: number;
  graderMajors: number;
}

export function calibrationOutcome(
  item: CalibrationItem,
  result: GradingResult,
): CalibrationOutcome {
  const majors = item.errors.filter(
    (e) =>
      e.severity === 'major' &&
      (e.targetStart !== null || e.sourceStart !== null),
  );
  return {
    id: item.id,
    mqmPenalty: item.penalty,
    graderPenalty: errorPenalty(result.errors),
    overall: overallScore(result),
    majorSpans: majors.length,
    majorFound: majors.filter((e) =>
      found(
        {
          translation:
            e.targetStart === null ? null : [e.targetStart, e.targetEnd!],
          source: e.sourceStart === null ? null : [e.sourceStart, e.sourceEnd!],
        },
        result.errors,
      ),
    ).length,
    graderMajors: result.errors.filter((e) => e.severity === 'major').length,
  };
}

export interface LearnerOutcome {
  id: string;
  kind: LearnerItem['kind'];
  overall: number;
  accuracy: number;
  completeness: number;
  injected: number;
  injectedFound: number;
  graderMajors: number;
  graderPenalty: number;
}

function injectedRanges(item: LearnerItem, error: InjectedError) {
  const t = error.translationSpan
    ? findSpan(item.translation, error.translationSpan)
    : null;
  const s = error.sourceSpan ? findSpan(item.source, error.sourceSpan) : null;
  return {
    translation:
      t === null
        ? null
        : ([t, t + error.translationSpan.trim().length] as [number, number]),
    source:
      s === null
        ? null
        : ([s, s + error.sourceSpan.trim().length] as [number, number]),
  };
}

export function learnerOutcome(
  item: LearnerItem,
  result: GradingResult,
): LearnerOutcome {
  return {
    id: item.id,
    kind: item.kind,
    overall: overallScore(result),
    accuracy: result.scores.accuracy.score,
    completeness: result.scores.completeness.score,
    injected: item.injected.length,
    injectedFound: item.injected.filter((e) =>
      found(injectedRanges(item, e), result.errors),
    ).length,
    graderMajors: result.errors.filter((e) => e.severity === 'major').length,
    graderPenalty: errorPenalty(result.errors),
  };
}

const round = (n: number | null) =>
  n === null ? null : Math.round(n * 1000) / 1000;
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const share = (n: number, d: number) => (d ? n / d : null);

export function calibrationMetrics(outcomes: readonly CalibrationOutcome[]) {
  const sum = (f: (o: CalibrationOutcome) => number) =>
    outcomes.reduce((n, o) => n + f(o), 0);
  const clean = outcomes.filter((o) => o.mqmPenalty === 0);
  return {
    items: outcomes.length,
    /** Rank agreement between MQM penalties and the grader's (higher is better). */
    penaltySpearman: round(
      spearman(
        outcomes.map((o) => o.mqmPenalty),
        outcomes.map((o) => o.graderPenalty),
      ),
    ),
    /** Rank agreement between MQM penalties and lower overall scores. */
    scoreSpearman: round(
      spearman(
        outcomes.map((o) => o.mqmPenalty),
        outcomes.map((o) => -o.overall),
      ),
    ),
    /** Share of MQM major errors the grader's spans cover. */
    majorSpanRecall: round(
      share(
        sum((o) => o.majorFound),
        sum((o) => o.majorSpans),
      ),
    ),
    /** Share of error-free translations given no major error. */
    cleanWithoutMajor: round(
      share(clean.filter((o) => o.graderMajors === 0).length, clean.length),
    ),
  };
}

export function learnerMetrics(outcomes: readonly LearnerOutcome[]) {
  const injected = outcomes.filter((o) => o.kind === 'injected');
  const paraphrases = outcomes.filter((o) => o.kind === 'paraphrase');
  return {
    items: outcomes.length,
    /** Share of injected errors the grader's spans cover. */
    injectedRecall: round(
      share(
        injected.reduce((n, o) => n + o.injectedFound, 0),
        injected.reduce((n, o) => n + o.injected, 0),
      ),
    ),
    /** Share of faithful paraphrases given no major error (the reference isn't the only answer). */
    paraphraseWithoutMajor: round(
      share(
        paraphrases.filter((o) => o.graderMajors === 0).length,
        paraphrases.length,
      ),
    ),
    meanOverallInjected: round(mean(injected.map((o) => o.overall))),
    meanOverallParaphrase: round(mean(paraphrases.map((o) => o.overall))),
  };
}
