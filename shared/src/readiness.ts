// Estimated readiness for each HSK exam, from 0 to 100. Derived from logs like
// everything else about progress, and never stored.
//
// 60% vocabulary: how much of the level is known. Every card counts, pinyin
// and handwriting alike, and an unstarted card counts as not known, so a few
// perfect words can't score well on their own.
// 20% reading and 20% listening: first tries at exercises finished in the last
// week. FIRST_TRY_TARGET earns full credit, and no recent exercises earn none.

import type { ActivityAnswer } from './activity.js';
import type { CardKind, HskLevel, Rating, WordNote } from './content.js';
import type { CharacterContent, DatasetResponse } from './dataset.js';
import {
  HSK_LEVEL_LABELS,
  HSK_LEVELS,
  parseCardKey,
  type CardSummary,
} from './queue.js';

export const READINESS_WEIGHTS = {
  vocabulary: 0.6,
  reading: 0.2,
  listening: 0.2,
} as const;

/** How far back exercises count. */
export const READINESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The share of first tries that earns full credit for reading or listening. */
export const FIRST_TRY_TARGET = 0.9;
/** A card's recall is judged on this many of its latest answers. */
export const RECALL_REVIEWS = 3;

const RATING_SCORES: Record<Rating, number> = { 1: 0, 2: 0.5, 3: 1, 4: 1 };

/**
 * How well each card is recalled, from 0 to 1: the average of its latest
 * answers, where Good and Easy are full marks, Hard half, and Again none.
 */
export function cardRecall(
  reviews: readonly {
    cardKey: string;
    rating: Rating;
    reviewedAt: string | Date;
  }[],
): Map<string, number> {
  const latest = new Map<string, Rating[]>();
  const time = (at: string | Date) => new Date(at).getTime();
  const inOrder = [...reviews].sort(
    (a, b) => time(a.reviewedAt) - time(b.reviewedAt),
  );
  for (const { cardKey, rating } of inOrder) {
    const ratings = latest.get(cardKey) ?? [];
    ratings.push(rating);
    if (ratings.length > RECALL_REVIEWS) ratings.shift();
    latest.set(cardKey, ratings);
  }
  return new Map(
    [...latest].map(([key, ratings]) => [
      key,
      ratings.reduce((sum, r) => sum + RATING_SCORES[r], 0) / ratings.length,
    ]),
  );
}

type Skill = 'reading' | 'listening';

/** An exercise's skill and level, from its ID (p2-0001, l1-0001). */
function parseExerciseId(id: string): { skill: Skill; level: number } | null {
  const match = /^([pl])(\d+)-/.exec(id);
  if (!match) return null;
  return {
    skill: match[1] === 'l' ? 'listening' : 'reading',
    level: Number(match[2]),
  };
}

/**
 * The share of questions right on the first try, by skill and level, over
 * exercises with every question answered in the window. "First" means first
 * within the window, since the library is small enough that a learner must
 * come back to exercises.
 */
export function firstTryShares(
  answers: readonly ActivityAnswer[],
  questionCounts: Readonly<Record<string, number>>,
  now: Date,
): Map<string, number> {
  const since = now.getTime() - READINESS_WINDOW_MS;
  const firstTries = new Map<string, Map<string, ActivityAnswer>>();
  const inOrder = answers
    .filter((a) => new Date(a.at).getTime() >= since)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  for (const answer of inOrder) {
    const questions = firstTries.get(answer.exerciseId) ?? new Map();
    if (!questions.has(answer.questionId)) {
      questions.set(answer.questionId, answer);
    }
    firstTries.set(answer.exerciseId, questions);
  }

  const totals = new Map<string, { right: number; asked: number }>();
  for (const [exerciseId, questions] of firstTries) {
    const exercise = parseExerciseId(exerciseId);
    if (!exercise || questions.size !== questionCounts[exerciseId]) continue;
    const key = `${exercise.skill}:${exercise.level}`;
    const total = totals.get(key) ?? { right: 0, asked: 0 };
    total.asked += questions.size;
    for (const { correct } of questions.values()) if (correct) total.right++;
    totals.set(key, total);
  }
  return new Map(
    [...totals].map(([key, { right, asked }]) => [key, right / asked]),
  );
}

export interface LevelReadiness {
  level: HskLevel;
  label: string;
  /** Estimated readiness, 0 to 100. Rounds down: 100 means all of it. */
  score: number;
  /** Cards at this level that have been started, from 0 to 1. */
  started: number;
  /** Average recall of those cards, from 0 to 1; null before any is started. */
  recall: number | null;
  /** First-try share this week, from 0 to 1; null without a finished exercise. */
  reading: number | null;
  listening: number | null;
}

export interface ReadinessInput {
  summaries: ReadonlyMap<string, CardSummary>;
  words: ReadonlyMap<string, WordNote>;
  characters: ReadonlyMap<string, CharacterContent>;
  dataset: Pick<DatasetResponse, 'levelCounts' | 'characterLevelCounts'>;
  /** From cardRecall. */
  recall: ReadonlyMap<string, number>;
  answers: readonly ActivityAnswer[];
  questionCounts: Readonly<Record<string, number>>;
  now: Date;
}

const STUDIED: readonly CardKind[] = ['pinyin', 'handwriting'];

/** Readiness for every level. Handwriting always counts toward it. */
export function buildReadiness({
  summaries,
  words,
  characters,
  dataset,
  recall,
  answers,
  questionCounts,
  now,
}: ReadinessInput): LevelReadiness[] {
  const known = new Map<number, { started: number; recall: number }>();
  for (const { key } of summaries.values()) {
    const card = parseCardKey(key);
    if (!card || !STUDIED.includes(card.kind)) continue;
    const level =
      card.kind === 'handwriting'
        ? characters.get(card.noteId)?.introLevel
        : words.get(card.noteId)?.level;
    if (!level) continue;
    const total = known.get(level) ?? { started: 0, recall: 0 };
    total.started++;
    total.recall += recall.get(key) ?? 0;
    known.set(level, total);
  }

  const shares = firstTryShares(answers, questionCounts, now);
  const credit = (share: number | null) =>
    Math.min(1, (share ?? 0) / FIRST_TRY_TARGET);

  return HSK_LEVELS.map((level): LevelReadiness => {
    const cards =
      (dataset.levelCounts[level] ?? 0) +
      (dataset.characterLevelCounts[level] ?? 0);
    const { started = 0, recall: recalled = 0 } = known.get(level) ?? {};
    const reading = shares.get(`reading:${level}`) ?? null;
    const listening = shares.get(`listening:${level}`) ?? null;
    const score =
      READINESS_WEIGHTS.vocabulary * (cards ? recalled / cards : 0) +
      READINESS_WEIGHTS.reading * credit(reading) +
      READINESS_WEIGHTS.listening * credit(listening);
    return {
      level,
      label: HSK_LEVEL_LABELS[level],
      // The nudge keeps a sum of exact tenths from falling just short of 100.
      score: Math.floor(score * 100 + 1e-9),
      started: cards ? started / cards : 0,
      recall: started ? recalled / started : null,
      reading,
      listening,
    };
  });
}
