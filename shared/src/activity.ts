// A learner's history: what was done on each study day, and streaks. Derived
// from the logs (review logs on the device, question answers and translations
// from GET /api/activity), never stored.

import type { Rating } from './content.js';
import { studyDayKey } from './queue.js';

/** Longest a single card counts for, so walking away doesn't inflate study time. */
export const MAX_COUNTED_CARD_MS = 2 * 60 * 1000;

/** One answer to a reading or listening question. */
export interface ActivityAnswer {
  /** A passage (p1-0001) or listening exercise (l1-0001). */
  exerciseId: string;
  questionId: string;
  correct: boolean;
  /** ISO timestamp. */
  at: string;
}

/** GET /api/activity: what only the server knows. Reviews come from local logs. */
export interface ActivityResponse {
  answers: ActivityAnswer[];
  /** When each graded translation was graded, as ISO timestamps. */
  translations: string[];
  /** How many questions each answered exercise has. */
  questionCounts: Record<string, number>;
}

export interface DayActivity {
  /** The study day, as YYYY-MM-DD. */
  day: string;
  /** Every card answer, including repeats of a card. */
  answers: number;
  /** Answers rated Good or Easy. */
  correct: number;
  /** Cards seen for the first time. */
  newCards: number;
  /** Different cards from earlier days that were answered. */
  reviewedCards: number;
  /** Time on cards, each capped at MAX_COUNTED_CARD_MS. */
  durationMs: number;
  readingQuestions: number;
  /** Passages with every question answered that day. */
  readingExercises: number;
  listeningQuestions: number;
  /** Listening exercises with every question answered that day. */
  listeningExercises: number;
  translations: number;
}

export interface ActivityInput extends Partial<ActivityResponse> {
  reviews: readonly {
    cardKey: string;
    rating: Rating;
    reviewedAt: string | Date;
    durationMs?: number;
  }[];
  timeZone: string;
}

const emptyDay = (day: string): DayActivity => ({
  day,
  answers: 0,
  correct: 0,
  newCards: 0,
  reviewedCards: 0,
  durationMs: 0,
  readingQuestions: 0,
  readingExercises: 0,
  listeningQuestions: 0,
  listeningExercises: 0,
  translations: 0,
});

/** Each study day with any activity, oldest first. */
export function buildActivity({
  reviews,
  answers = [],
  translations = [],
  questionCounts = {},
  timeZone,
}: ActivityInput): DayActivity[] {
  const days = new Map<string, DayActivity>();
  const dayOf = (at: string | Date) => {
    const key = studyDayKey(new Date(at), timeZone);
    let day = days.get(key);
    if (!day) days.set(key, (day = emptyDay(key)));
    return day;
  };

  const time = (at: string | Date) => new Date(at).getTime();
  const firstDay = new Map<string, string>();
  const reviewedOn = new Set<string>();
  const inOrder = [...reviews].sort(
    (a, b) => time(a.reviewedAt) - time(b.reviewedAt),
  );
  for (const review of inOrder) {
    const day = dayOf(review.reviewedAt);
    day.answers++;
    if (review.rating >= 3) day.correct++;
    day.durationMs += Math.min(review.durationMs ?? 0, MAX_COUNTED_CARD_MS);
    const first = firstDay.get(review.cardKey);
    if (first === undefined) {
      firstDay.set(review.cardKey, day.day);
      day.newCards++;
    } else if (first !== day.day) {
      const key = `${day.day}:${review.cardKey}`;
      if (!reviewedOn.has(key)) {
        reviewedOn.add(key);
        day.reviewedCards++;
      }
    }
  }

  // Which questions of each exercise were answered, by day.
  const answered = new Map<string, Set<string>>();
  for (const answer of answers) {
    const day = dayOf(answer.at);
    const listening = answer.exerciseId.startsWith('l');
    if (listening) day.listeningQuestions++;
    else day.readingQuestions++;

    const key = `${day.day}:${answer.exerciseId}`;
    const questions = answered.get(key) ?? new Set();
    const before = questions.size;
    questions.add(answer.questionId);
    answered.set(key, questions);
    if (
      questions.size > before &&
      questions.size === questionCounts[answer.exerciseId]
    ) {
      if (listening) day.listeningExercises++;
      else day.readingExercises++;
    }
  }

  for (const at of translations) dayOf(at).translations++;

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The study day `n` days after `day` (YYYY-MM-DD); `n` may be negative. */
export function addDays(day: string, n: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + n))
    .toISOString()
    .slice(0, 10);
}

export interface Streaks {
  /** Days in a row up to today, or up to yesterday if today isn't started. */
  current: number;
  longest: number;
  /** Study days with any activity. */
  activeDays: number;
  /** Whether today already counts. */
  activeToday: boolean;
}

/** Streaks over `buildActivity`'s days, which are all active. */
export function computeStreaks(
  days: readonly Pick<DayActivity, 'day'>[],
  today: string,
): Streaks {
  const active = new Set(days.map((d) => d.day));
  let longest = 0;
  for (const { day } of days) {
    // Count each run once, from its first day.
    if (active.has(addDays(day, -1))) continue;
    let length = 1;
    while (active.has(addDays(day, length))) length++;
    longest = Math.max(longest, length);
  }
  const activeToday = active.has(today);
  let current = 0;
  let day = activeToday ? today : addDays(today, -1);
  while (active.has(day)) {
    current++;
    day = addDays(day, -1);
  }
  return { current, longest, activeDays: active.size, activeToday };
}
