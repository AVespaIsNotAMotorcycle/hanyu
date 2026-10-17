// Handwriting cards: strictness settings, grading a hanzi-writer quiz into an
// FSRS rating, and telling stroke-order mistakes from other misses.

import type { Rating } from './content.js';

export interface HandwritingSettings {
  /** Handwriting cards are introduced for characters of started words. */
  enabled: boolean;
  /**
   * `strict`: a stroke drawn out of order is a miss. `lenient`: it isn't
   * counted (hanzi-writer still waits for the right stroke before moving on).
   */
  strokeOrder: 'strict' | 'lenient';
  /** Misses that still pass (rated Hard). More than this is Again. */
  allowedMisses: number;
}

export const DEFAULT_HANDWRITING: HandwritingSettings = {
  enabled: true,
  strokeOrder: 'strict',
  allowedMisses: 2,
};
export const MAX_ALLOWED_MISSES = 10;

/** hanzi-writer quiz behavior shared by every handwriting card. */
export const QUIZ_OPTIONS = {
  /** Highlight the expected stroke after this many misses on it (counts as a hint). */
  showHintAfterMisses: 3,
  /** Accept the stroke after this many misses on it, so nobody gets stuck. */
  markStrokeCorrectAfterMisses: 5,
} as const;

/** What happened while drawing one character. */
export interface HandwritingResult {
  strokes: number;
  /** Every stroke hanzi-writer rejected. */
  misses: number;
  /** Rejected strokes that matched a later stroke: right stroke, wrong order. */
  orderMisses: number;
  /** A stroke was highlighted, by request or after repeated misses. */
  hinted: boolean;
  /** The learner gave up and was shown the character. */
  revealed: boolean;
}

/** Misses that count toward the grade under these settings. */
export function countedMisses(
  result: HandwritingResult,
  settings: HandwritingSettings,
): number {
  return settings.strokeOrder === 'lenient'
    ? result.misses - result.orderMisses
    : result.misses;
}

/**
 * The FSRS rating for a drawn character: clean → Good; a few misses (up to
 * `allowedMisses`) → Hard; more misses, any hint, or giving up → Again.
 * Easy is never assigned automatically.
 */
export function ratingForHandwriting(
  result: HandwritingResult,
  settings: HandwritingSettings,
): Rating {
  if (result.revealed || result.hinted) return 1;
  const misses = countedMisses(result, settings);
  if (misses > settings.allowedMisses) return 1;
  return misses > 0 ? 2 : 3;
}

/** A compact record of the attempt, stored as the review log's `answer`. */
export function describeHandwriting(result: HandwritingResult): string {
  return JSON.stringify(result);
}

// --- Stroke-order mistakes ----------------------------------------------------

export type Point = { x: number; y: number } | [number, number];

const xy = (p: Point) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p);

function distance(a: Point, b: Point) {
  const [p, q] = [xy(a), xy(b)];
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** Distance from a point to the nearest point on a polyline. */
function distanceToPolyline(point: Point, line: readonly Point[]): number {
  const p = xy(point);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = xy(line[i]!);
    const b = xy(line[i + 1]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t =
      length2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2),
          );
    best = Math.min(
      best,
      Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)),
    );
  }
  return line.length === 1 ? distance(point, line[0]!) : best;
}

// In Make Me a Hanzi's 1024-unit coordinates; close to hanzi-writer's own
// thresholds for an accepted stroke (average 175, endpoints 250).
const MAX_AVERAGE_DISTANCE = 175;
const MAX_ENDPOINT_DISTANCE = 250;

/** How well a drawn stroke fits a stroke median (lower is better), or null if it doesn't. */
function fit(drawn: readonly Point[], median: readonly Point[]): number | null {
  if (drawn.length < 2 || median.length < 2) return null;
  const average =
    drawn.reduce((sum, p) => sum + distanceToPolyline(p, median), 0) /
    drawn.length;
  const start = distance(drawn[0]!, median[0]!);
  const end = distance(drawn.at(-1)!, median.at(-1)!);
  if (
    average > MAX_AVERAGE_DISTANCE ||
    start > MAX_ENDPOINT_DISTANCE ||
    end > MAX_ENDPOINT_DISTANCE
  ) {
    return null;
  }
  return average;
}

/**
 * Whether a rejected stroke was a stroke-order mistake: it fits one of the
 * strokes still to come better than the expected one. `medians` are the
 * character's stroke medians; `expected` is the index hanzi-writer wanted.
 */
export function isStrokeOrderMistake(
  drawn: readonly Point[],
  medians: readonly (readonly Point[])[],
  expected: number,
): boolean {
  const expectedFit = fit(drawn, medians[expected] ?? []);
  for (let i = expected + 1; i < medians.length; i++) {
    const laterFit = fit(drawn, medians[i]!);
    if (laterFit !== null && (expectedFit === null || laterFit < expectedFit)) {
      return true;
    }
  }
  return false;
}
