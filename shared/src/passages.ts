// Reading passages: generated offline (data/src/passages), verified, stored
// as JSON in data/passages, loaded into MongoDB, and read in the client.

import {
  cardKey,
  type GrammarPoint,
  type HskLevel,
  type WordNote,
} from './content.js';
import type { CardSummary } from './queue.js';

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

/**
 * The automated answer-key check: a second model call answers the questions
 * from the passage alone, without the key, and reports problems. Passages
 * load only if it passed.
 */
export interface AnswerKeyCheck {
  model: string;
  promptVersion: string;
  checkedAt: string;
  passed: boolean;
  /** The checker's answer to each question, in question order. */
  answers: {
    questionId: string;
    /** The option it picked, or the word it filled in. */
    given: string;
    agrees: boolean;
    /** Other options it found defensible, or other words that fit. */
    alternatives: string[];
  }[];
  /** Problems with the passage or questions. A major one fails the check. */
  issues: { severity: 'major' | 'minor'; description: string }[];
  costUsd: number;
}

/** A spot-check by hand (npm run passages:review). */
export interface PassageReview {
  verdict: 'approved';
  reviewedAt: string;
  note: string;
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
  /**
   * The text segmented into words, one list per paragraph (each list joins
   * back into its paragraph). Compounds jieba groups are split into HSK
   * words, so each token can be looked up.
   */
  tokens: string[][];
  verification: LevelCheck;
  /** Null until `npm run passages:check` has run. */
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
  /** The words in the text (names left out), for recommendations. */
  vocabulary: PassageWord[];
}

/** A distinct token in a passage and the HSK words it could be. */
export interface PassageWord {
  text: string;
  /** Word IDs with this simplified form (several for homographs); empty outside HSK. */
  wordIds: string[];
  /** Occurrences in the text. */
  count: number;
}

/** GET /api/passages, or GET /api/passages?level=N for one level. */
export interface PassagesResponse {
  passages: PassageSummary[];
}

/** GET /api/passages/:id */
export interface PassageResponse {
  passage: Passage;
  /** The grammar points the passage exercises, for display. */
  grammarPoints: GrammarPoint[];
  /** Every HSK word whose simplified form is a token, for tap-to-look-up. */
  words: WordNote[];
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

/** Whether a token has hanzi, i.e. is a word to look up rather than punctuation. */
export function isHanziToken(token: string): boolean {
  return /\p{Script=Han}/u.test(token);
}

// --- Recommendations ------------------------------------------------------------

export interface Familiarity {
  /** Token occurrences whose word is in review (learned). */
  known: number;
  /** Token occurrences whose word is started but still in (re)learning. */
  learning: number;
  total: number;
  /** (known + learning / 2) / total: 0 to 1. */
  score: number;
}

/**
 * How much of a passage's text a learner knows, from their pinyin cards. A
 * homograph counts as known if any of its words is.
 */
export function passageFamiliarity(
  vocabulary: readonly PassageWord[],
  summaries: ReadonlyMap<string, CardSummary>,
): Familiarity {
  let known = 0;
  let learning = 0;
  let total = 0;
  for (const { wordIds, count } of vocabulary) {
    total += count;
    const phases = wordIds.flatMap((id) => {
      const summary = summaries.get(cardKey('word', id, 'pinyin'));
      return summary ? [summary.schedule.phase] : [];
    });
    if (phases.includes('review')) known += count;
    else if (phases.length) learning += count;
  }
  return {
    known,
    learning,
    total,
    score: total ? (known + learning / 2) / total : 0,
  };
}

export interface Recommendation {
  passage: PassageSummary;
  familiarity: Familiarity;
}

/**
 * Passages to read next: unread ones (all of them, once everything is read),
 * most familiar first, then lower levels. Mostly-known vocabulary makes for
 * reading practice rather than decoding.
 */
export function recommendPassages(
  passages: readonly PassageSummary[],
  summaries: ReadonlyMap<string, CardSummary>,
  read: ReadonlySet<string>,
  limit = 3,
): Recommendation[] {
  const unread = passages.filter((p) => !read.has(p._id));
  return (unread.length ? unread : passages)
    .map((passage) => ({
      passage,
      familiarity: passageFamiliarity(passage.vocabulary, summaries),
    }))
    .sort(
      (a, b) =>
        b.familiarity.score - a.familiarity.score ||
        a.passage.level - b.passage.level ||
        a.passage._id.localeCompare(b.passage._id),
    )
    .slice(0, limit);
}
