// Listening exercises: one to three sentences read aloud (the text stays
// hidden), with multiple-choice questions about them. Generated offline
// (data/src/listening), verified, recorded, stored as JSON in data/listening,
// loaded into MongoDB, and played in the client.

import type { HskLevel } from './content.js';
import type {
  AnswerKeyCheck,
  ChoiceQuestion,
  LevelCheck,
  PassageGrammarUse,
  PassageReview,
  QuestionProgress,
} from './passages.js';

/** Most sentences an exercise reads. */
export const MAX_LISTENING_SENTENCES = 3;

/** Questions per exercise, fewest to most. */
export const LISTENING_QUESTIONS: [number, number] = [1, 2];

export interface ListeningExercise {
  /** `l1-0001`: level, then a sequence number. */
  _id: string;
  level: HskLevel;
  /** What's read aloud: one to three sentences. Never shown before answering. */
  text: string;
  /** An English translation of the text, shown with the transcript. */
  textEnglish: string;
  /** A short English description of the situation (for variety in generation). */
  topic: string;
  /** Names used in the text (not HSK words; counted as known). */
  names: string[];
  grammar: PassageGrammarUse[];
  questions: ChoiceQuestion[];
  verification: LevelCheck;
  /** Null until `npm run listening:check` has run. */
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

/** For lists: nothing that gives the text away. */
export interface ListeningSummary {
  _id: string;
  level: HskLevel;
  questionCount: number;
  /** The signed-in user's questions answered so far, and answered right. */
  progress: { answered: number; correct: number };
}

/** GET /api/listening, or GET /api/listening?level=N for one level. */
export interface ListeningListResponse {
  exercises: ListeningSummary[];
}

/** GET /api/listening/:id */
export interface ListeningResponse {
  exercise: ListeningExercise;
  /** The signed-in user's record on each question answered before. */
  progress: QuestionProgress[];
}

/** Sentences in a text: runs ending in 。！？ (or the end of the text). */
export function countSentences(text: string): number {
  return (text.match(/[^。！？!?]+[。！？!?]*/g) ?? []).filter((s) =>
    /\p{Script=Han}/u.test(s),
  ).length;
}
