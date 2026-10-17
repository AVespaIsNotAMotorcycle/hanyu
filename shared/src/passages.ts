// Reading passages: generated offline (data/src/passages), verified, stored
// as JSON in data/passages, loaded into MongoDB, and read in the client.

import type { GrammarPoint, HskLevel } from './content.js';

/** Marks the gap in a cloze sentence. */
export const CLOZE_BLANK = '＿＿';

/** Share of a passage's tokens that must be at or below its level. */
export const MIN_LEVEL_SHARE = 0.95;

/** A grammar point the passage exercises, with the text that shows it. */
export interface PassageGrammarUse {
  /** Grammar point ID (`g1-008`). */
  grammarId: string;
  /** A span quoted from the passage that uses it. */
  example: string;
}

export interface ChoiceQuestion {
  id: string;
  type: 'choice';
  /** The question, in Chinese at the passage's level. */
  prompt: string;
  /** English translation of the prompt, shown on request. */
  promptEnglish: string;
  /** Four options, in Chinese. */
  options: string[];
  /** Index of the correct option. */
  answer: number;
  /** Why it's right, in English, shown after answering. */
  explanation: string;
}

export interface ClozeQuestion {
  id: string;
  type: 'cloze';
  /** A sentence from the passage with CLOZE_BLANK where the answer goes. */
  sentence: string;
  /** The missing word: an HSK word at or below the level. */
  answer: string;
  /** Other words that fit just as well. */
  alsoAccepted: string[];
  /** An English hint for the missing word. */
  hint: string;
}

export type PassageQuestion = ChoiceQuestion | ClozeQuestion;

export interface LevelCheck {
  /** Hanzi tokens from the segmenter. */
  tokens: number;
  /** Tokens that are (or split into) HSK words at or below the level, or declared names. */
  atOrBelowLevel: number;
  share: number;
  /** Distinct tokens above the level or outside HSK. */
  offLevel: string[];
}

export interface Passage {
  /** `p1-0001`: level, then a sequence number. */
  _id: string;
  level: HskLevel;
  title: string;
  titleEnglish: string;
  /** Paragraphs separated by blank lines. */
  text: string;
  /** Names used in the passage (not HSK words; counted as known). */
  names: string[];
  grammar: PassageGrammarUse[];
  questions: PassageQuestion[];
  verification: LevelCheck;
  generation: {
    model: string;
    promptVersion: string;
    generatedAt: string;
    attempts: number;
    costUsd: number;
  };
}

/** For lists: everything but the text and questions. */
export interface PassageSummary {
  _id: string;
  level: HskLevel;
  title: string;
  titleEnglish: string;
  /** Characters in the text. */
  length: number;
  grammarIds: string[];
  questionCount: number;
}

/** GET /api/passages?level=N */
export interface PassagesResponse {
  passages: PassageSummary[];
}

/** GET /api/passages/:id */
export interface PassageResponse {
  passage: Passage;
  /** The grammar points the passage exercises, for display. */
  grammarPoints: GrammarPoint[];
}

/** Strips what shouldn't decide a typed answer: spaces, punctuation, width. */
export function normalizeHanziAnswer(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

/** Whether typed text answers a cloze question. */
export function checkClozeAnswer(
  typed: string,
  question: Pick<ClozeQuestion, 'answer' | 'alsoAccepted'>,
): boolean {
  const answer = normalizeHanziAnswer(typed);
  return (
    answer !== '' &&
    [question.answer, ...question.alsoAccepted].some(
      (accepted) => normalizeHanziAnswer(accepted) === answer,
    )
  );
}

/** The passage paragraphs. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
