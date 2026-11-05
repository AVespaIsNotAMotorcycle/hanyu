// A learner's history: what was done on each study day, and streaks. Derived
// from the logs (review logs on the device, question answers and translations
// from GET /api/activity), never stored.

import type { Rating } from './content.js';
import { studyDayKey, type StudyQueue } from './queue.js';

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

/** One graded translation of a passage's paragraph. */
export interface ActivityTranslation {
  exerciseId: string;
  paragraph: number;
  /** ISO timestamp. */
  at: string;
}

/** GET /api/activity: what only the server knows. Reviews come from local logs. */
export interface ActivityResponse {
  answers: ActivityAnswer[];
  translations: ActivityTranslation[];
  /** How many questions each exercise worked on has. */
  questionCounts: Record<string, number>;
  /** How many paragraphs of each passage worked on must be translated. */
  translationCounts: Record<string, number>;
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
  /** Passages with every question answered and paragraph translated that day. */
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

const isListening = (exerciseId: string) => exerciseId.startsWith('l');

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
  translationCounts = {},
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

  // What was done on each exercise, by day.
  const worked = new Map<
    string,
    {
      day: DayActivity;
      exerciseId: string;
      questions: Set<string>;
      paragraphs: Set<number>;
    }
  >();
  const workOn = (exerciseId: string, at: string) => {
    const day = dayOf(at);
    const key = `${day.day}:${exerciseId}`;
    let work = worked.get(key);
    if (!work) {
      work = {
        day,
        exerciseId,
        questions: new Set(),
        paragraphs: new Set(),
      };
      worked.set(key, work);
    }
    return work;
  };

  for (const { exerciseId, questionId, at } of answers) {
    const work = workOn(exerciseId, at);
    work.questions.add(questionId);
    if (isListening(exerciseId)) work.day.listeningQuestions++;
    else work.day.readingQuestions++;
  }
  for (const { exerciseId, paragraph, at } of translations) {
    const work = workOn(exerciseId, at);
    work.paragraphs.add(paragraph);
    work.day.translations++;
  }
  for (const { day, exerciseId, questions, paragraphs } of worked.values()) {
    if (
      questions.size !== questionCounts[exerciseId] ||
      paragraphs.size < (translationCounts[exerciseId] ?? 0)
    ) {
      continue;
    }
    if (isListening(exerciseId)) day.listeningExercises++;
    else day.readingExercises++;
  }

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

export type ChecklistId = 'review' | 'new' | 'reading' | 'listening';

export interface ChecklistItem {
  id: ChecklistId;
  done: boolean;
  /** How much of today's goal is done. */
  count: number;
  /** Today's goal; 0 when there was nothing to do. */
  goal: number;
}

/**
 * Today's checklist: clear the due cards, learn today's new words, and finish
 * one reading passage (questions and translation) and one listening exercise.
 * Nothing due counts as done.
 */
export function dailyChecklist(
  today: DayActivity | undefined,
  queue: Pick<StudyQueue, 'dueCount' | 'newWordCount' | 'wordsIntroducedToday'>,
): ChecklistItem[] {
  const reviewed = today?.reviewedCards ?? 0;
  const reading = today?.readingExercises ?? 0;
  const listening = today?.listeningExercises ?? 0;
  return [
    {
      id: 'review',
      done: queue.dueCount === 0,
      count: reviewed,
      goal: reviewed + queue.dueCount,
    },
    {
      id: 'new',
      done: queue.newWordCount === 0,
      count: queue.wordsIntroducedToday,
      goal: queue.wordsIntroducedToday + queue.newWordCount,
    },
    { id: 'reading', done: reading >= 1, count: Math.min(reading, 1), goal: 1 },
    {
      id: 'listening',
      done: listening >= 1,
      count: Math.min(listening, 1),
      goal: 1,
    },
  ];
}
