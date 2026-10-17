// FSRS scheduling, shared so the client (offline) and server compute the same
// card state. State is never stored as truth: it is replayed from the card's
// append-only review logs (see "Sync Review Logs, Not Card State" in
// ROADMAP.md), so every function here must stay deterministic.

import {
  createEmptyCard,
  fsrs,
  State,
  type Card as FsrsCard,
  type FSRSParameters,
  type Grade,
} from 'ts-fsrs';
import type { Rating } from './content.js';

export const SCHEDULER_PARAMS: Partial<FSRSParameters> = {
  request_retention: 0.9,
  maximum_interval: 36500,
  // Spreads out cards introduced together. The fuzz is seeded from the review
  // time and card state, so replays still give identical results.
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
};

const scheduler = fsrs(SCHEDULER_PARAMS);

export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';

/** A card's FSRS state, derived from its review logs. */
export interface CardSchedule {
  phase: CardPhase;
  /** When the card is next due. For new cards, when it was created. */
  due: Date;
  stability: number;
  difficulty: number;
  /** Days between the last review and `due` (0 while in learning steps). */
  scheduledDays: number;
  /** Index of the current (re)learning step. */
  learningStep: number;
  reps: number;
  lapses: number;
  lastReview: Date | null;
}

/** The parts of a review log that scheduling depends on. */
export interface ReviewEvent {
  /** Client-generated UUID; breaks ties between reviews at the same time. */
  _id: string;
  rating: Rating;
  /** A Date, or an ISO string or epoch milliseconds (from JSON or IndexedDB). */
  reviewedAt: Date | string | number;
}

const PHASES: Record<State, CardPhase> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};
const STATES = Object.fromEntries(
  Object.entries(PHASES).map(([state, phase]) => [phase, Number(state)]),
) as Record<CardPhase, State>;

function toDate(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid review time: ${String(value)}`);
  }
  return date;
}

function fromFsrs(card: FsrsCard): CardSchedule {
  return {
    phase: PHASES[card.state],
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningStep: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.last_review ?? null,
  };
}

function toFsrs(schedule: CardSchedule): FsrsCard {
  return {
    state: STATES[schedule.phase],
    due: schedule.due,
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsed_days: 0, // deprecated in ts-fsrs and unused by the scheduler
    scheduled_days: schedule.scheduledDays,
    learning_steps: schedule.learningStep,
    reps: schedule.reps,
    lapses: schedule.lapses,
    last_review: schedule.lastReview ?? undefined,
  };
}

export function isRating(value: unknown): value is Rating {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** A card that has never been reviewed. */
export function newCardSchedule(createdAt: Date = new Date()): CardSchedule {
  return fromFsrs(createEmptyCard(createdAt));
}

/** The card's state after one more review. */
export function applyReview(
  schedule: CardSchedule,
  review: Pick<ReviewEvent, 'rating' | 'reviewedAt'>,
): CardSchedule {
  if (!isRating(review.rating)) {
    throw new RangeError(`Invalid rating: ${String(review.rating)}`);
  }
  const at = toDate(review.reviewedAt);
  return fromFsrs(
    scheduler.next(toFsrs(schedule), at, review.rating as Grade).card,
  );
}

/** Orders reviews by time, then ID, so every device replays them alike. */
export function compareReviews(a: ReviewEvent, b: ReviewEvent): number {
  return (
    toDate(a.reviewedAt).getTime() - toDate(b.reviewedAt).getTime() ||
    (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
  );
}

/**
 * Recomputes a card's state from all of its reviews, in any order. Merging
 * logs from several devices and replaying gives the same state everywhere.
 */
export function replayReviews(reviews: readonly ReviewEvent[]): CardSchedule {
  const sorted = [...reviews].sort(compareReviews);
  const first = sorted[0];
  return sorted.reduce(
    applyReview,
    newCardSchedule(first ? toDate(first.reviewedAt) : undefined),
  );
}

/** Replays a mixed stream of logs into one schedule per card key. */
export function replayByCard(
  reviews: Iterable<ReviewEvent & { cardKey: string }>,
): Map<string, CardSchedule> {
  const byCard = new Map<string, ReviewEvent[]>();
  for (const review of reviews) {
    const list = byCard.get(review.cardKey);
    if (list) list.push(review);
    else byCard.set(review.cardKey, [review]);
  }
  return new Map(
    [...byCard].map(([key, list]) => [key, replayReviews(list)] as const),
  );
}

/** Whether a reviewed card should be shown now. New cards are never "due". */
export function isDue(schedule: CardSchedule, now: Date = new Date()) {
  return schedule.phase !== 'new' && schedule.due.getTime() <= now.getTime();
}

/** When the card would next be due for each possible rating (for buttons). */
export function previewDue(
  schedule: CardSchedule,
  now: Date = new Date(),
): Record<Rating, Date> {
  const preview = scheduler.repeat(toFsrs(schedule), now);
  return {
    1: preview[1].card.due,
    2: preview[2].card.due,
    3: preview[3].card.due,
    4: preview[4].card.due,
  };
}

/** Estimated probability (0–1) of recalling the card now. */
export function retrievability(
  schedule: CardSchedule,
  now: Date = new Date(),
): number {
  if (schedule.phase === 'new') return 0;
  return scheduler.get_retrievability(toFsrs(schedule), now, false);
}
