// English → Chinese translation exercises: a short English paragraph that
// learners translate into Chinese, graded by an LLM against a reference
// Chinese translation written with the level's vocabulary. Generated offline
// (data/src/translate), verified, stored as JSON in data/translate, loaded
// into MongoDB, and done on the client's Translate page.

import type { HskLevel } from './content.js';
import type { GradingLimits, TranslationGrading } from './grading.js';
import type {
  AnswerKeyCheck,
  LevelCheck,
  PassageGrammarUse,
  PassageReview,
} from './passages.js';

export interface TranslateExercise {
  /** `t1-0001`: level, then a sequence number. */
  _id: string;
  level: HskLevel;
  /** What learners translate: one short English paragraph. */
  english: string;
  /** A model Chinese translation, in the level's vocabulary. Shown after grading. */
  reference: string;
  /** A short English description of the situation (for variety in generation). */
  topic: string;
  /** The reference segmented into HSK words, for adding missed words to the SRS. */
  tokens: string[];
  grammar: PassageGrammarUse[];
  /** The level check on the reference. */
  verification: LevelCheck;
  /**
   * The reference check: an independent call confirms the reference is a
   * faithful, natural translation (`answers` is always empty). Null until run.
   */
  answerKeyCheck: AnswerKeyCheck | null;
  /** Null until spot-checked by hand. */
  review: PassageReview | null;
  generation: {
    model: string;
    promptVersion: string;
    generatedAt: string;
    attempts: number;
    costUsd: number;
  };
}

/** What the client gets before grading: no reference. */
export type TranslatePrompt = Pick<
  TranslateExercise,
  '_id' | 'level' | 'english' | 'topic'
>;

export interface TranslateSummary extends TranslatePrompt {
  /** The signed-in user's gradings, and the best overall score (null if none). */
  progress: { gradings: number; best: number | null };
}

/** GET /api/translate, or GET /api/translate?level=N for one level. */
export interface TranslateListResponse {
  exercises: TranslateSummary[];
}

/** GET /api/translate/:id: the exercise and the user's gradings, newest first. */
export interface TranslateResponse {
  exercise: TranslatePrompt;
  gradings: TranslationGrading[];
  limits: GradingLimits;
}

/** POST /api/translate/:id/gradings */
export interface GradeTranslateRequest {
  translation: string;
}

/** Translate exercise IDs start with `t` (passages `p`, listening `l`). */
export const isTranslateExercise = (id: string) => id.startsWith('t');
