// Translation grading, in both directions: Chinese → English (reading
// passages) and English → Chinese (Translate exercises). The rubric, the
// grader's prompts and reply schema, and checks on what it returns. The server
// calls it at request time; the data pipeline's eval scripts call it offline.

import type { AuthUser } from './auth.js';
import {
  closeObjects,
  costOf,
  replyJson,
  SONNET,
  type JsonLlm,
  type LlmUsage,
} from './llm.js';

export const GRADER_MODEL = SONNET;
/**
 * Bump when the grading prompt or schema changes, then run
 * `npm run grader:eval` (a test fails until results exist for the version).
 */
export const GRADER_PROMPT_VERSION = '1';
/** The same for the English → Chinese prompt (its own eval set and results). */
export const EN_ZH_GRADER_PROMPT_VERSION = '1';

/** Source → target language: reading passages are zh-en, Translate exercises en-zh. */
export type TranslationDirection = 'zh-en' | 'en-zh';
export const TRANSLATION_DIRECTIONS: readonly TranslationDirection[] = [
  'zh-en',
  'en-zh',
];

export const GRADER_PROMPT_VERSIONS: Record<TranslationDirection, string> = {
  'zh-en': GRADER_PROMPT_VERSION,
  'en-zh': EN_ZH_GRADER_PROMPT_VERSION,
};

export const CRITERIA = [
  'accuracy',
  'completeness',
  'grammar',
  'naturalness',
] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_LABELS: Record<Criterion, string> = {
  accuracy: 'Accuracy',
  completeness: 'Completeness',
  grammar: 'Grammar handling',
  naturalness: 'Naturalness',
};

/** Into Chinese, grammar judges the learner's own Chinese. */
export const CRITERION_LABELS_BY_DIRECTION: Record<
  TranslationDirection,
  Record<Criterion, string>
> = {
  'zh-en': CRITERION_LABELS,
  'en-zh': { ...CRITERION_LABELS, grammar: 'Grammar' },
};

export const MAX_TRANSLATION_LENGTH = 2000;
/** Most source words one grading adds to the SRS. */
export const MAX_MISTRANSLATED_WORDS = 5;

export interface TranslationInput {
  /** The paragraph to translate: Chinese (zh-en) or English (en-zh). */
  source: string;
  /** A model translation. */
  reference: string;
  /** The learner's translation. */
  translation: string;
}

export interface TranslationError {
  criterion: Criterion;
  severity: 'major' | 'minor';
  /** Quoted from the learner's translation; empty for an omission. */
  translationSpan: string;
  /** Quoted from the Chinese source; empty for an addition or an English-only problem. */
  sourceSpan: string;
  explanation: string;
  suggestion: string;
  /** Where the spans are (UTF-16 offsets), or null if empty or not found verbatim. */
  translationStart: number | null;
  sourceStart: number | null;
}

export interface GradingResult {
  /** 1 (poor) to 5 (excellent) per criterion, with a short comment. */
  scores: Record<Criterion, { score: number; comment: string }>;
  errors: TranslationError[];
  /** One or two sentences of feedback. */
  summary: string;
  /**
   * Chinese words the learner didn't know: from the source (zh-en, words
   * misunderstood) or from the reference (en-zh, words misused or avoided).
   */
  mistranslatedWords: string[];
}

const SYSTEM = `You grade English translations of short Chinese passages written by adult learners of Mandarin (HSK levels 1–6). You get the Chinese source, a reference translation, and the learner's translation.

Score each criterion from 1 to 5:
- accuracy: is the meaning right? Penalize mistranslated words, wrong subjects or objects, wrong numbers or times, and meaning changes. 5 = every meaning right; 3 = the gist is right but some meanings are wrong; 1 = mostly wrong.
- completeness: is everything there, and nothing invented? Penalize dropped words, phrases, or clauses, and additions not in the source. 5 = complete; 3 = a clause or several details missing; 1 = most of it missing.
- grammar: did the learner understand the Chinese grammar? Aspect and tense (了, 过, 着, 在, 要), negation (不 vs 没), comparisons (比), 把 and 被, questions, measure words and plurals, 的 relationships, and time and sequence. 5 = every structure understood; 3 = one or two misread; 1 = structures mostly misread.
- naturalness: does the English read naturally? Penalize word-for-word renderings and English grammar or spelling errors. 5 = reads like native English; 3 = understandable but stilted; 1 = hard to read.

Rules:
- The reference is one good translation, not the only one. Accept any translation that is faithful and natural, even if worded differently.
- List each error once, under the criterion it hurts most. Mark it "major" if it changes or loses meaning, "minor" for small imperfections. Don't list style preferences as errors.
- Quote spans exactly, character for character: translationSpan from the learner's translation (empty for an omission) and sourceSpan from the Chinese source (empty for an addition or an English-only problem).
- Give a short explanation for the learner and a suggested fix for each error.
- mistranslatedWords: the Chinese words, copied from the source, that the learner misunderstood (mistranslated, or left out because they didn't know them). Leave out words they translated freely but correctly.
- summary: one or two sentences, specific and encouraging, in English.

Reply with one JSON object in the required format.`;

const SYSTEM_EN_ZH = `You grade Chinese translations of short English passages written by adult learners of Mandarin (HSK levels 1–6) who are practicing writing Chinese. You get the English source, a reference Chinese translation written with the vocabulary of the learner's level, and the learner's Chinese translation, typed with an input method.

Score each criterion from 1 to 5:
- accuracy: does the Chinese say what the English says? Penalize wrong words (卖 for 买, 借 for 还), wrong subjects or objects, wrong numbers or times, and meaning changes. 5 = every meaning right; 3 = the gist is right but some meanings are wrong; 1 = mostly wrong.
- completeness: is everything there, and nothing invented? Penalize dropped words, phrases, or clauses, and additions not in the English. 5 = complete; 3 = a clause or several details missing; 1 = most of it missing.
- grammar: is the learner's Chinese grammatical? Word order (time and place before the verb), measure words, aspect (了, 过, 着, 在, 要), negation (不 vs 没), comparisons (比), 把 and 被, questions (吗, question words), 的/得/地, complements, and sentence-final particles. 5 = grammatical throughout; 3 = one or two structures wrong; 1 = mostly ungrammatical.
- naturalness: does it read like natural Chinese? Penalize word-for-word renderings of English (English word order, overused pronouns, 和 joining clauses), wrong collocations, and wrong characters. 5 = reads like a native speaker wrote it; 3 = understandable but foreign; 1 = hard to understand.

Rules:
- The reference is one good translation, not the only one. Accept any translation that is faithful, grammatical, and natural, even if worded differently or with words above the learner's level. Simplified and traditional characters are both fine.
- Wrong characters from the input method (homophones such as 在 for 再, 的 for 得) are naturalness errors: minor if the meaning stays clear, major if it changes. Pinyin written in place of characters is a minor naturalness error.
- List each error once, under the criterion it hurts most. Mark it "major" if it changes or loses meaning or is clearly ungrammatical, "minor" for small imperfections. Don't list style preferences as errors.
- Quote spans exactly, character for character: translationSpan from the learner's Chinese (empty for an omission) and sourceSpan from the English source (empty for an addition or a problem with no English counterpart).
- Give a short explanation in English for the learner, and a suggested fix in Chinese, for each error.
- mistranslatedWords: the Chinese words, copied from the reference translation, that the learner didn't know: where they used a wrong word or character, or left the meaning out. Leave out places where they chose a different correct word.
- summary: one or two sentences, specific and encouraging, in English.

Reply with one JSON object in the required format.`;

const SYSTEMS: Record<TranslationDirection, string> = {
  'zh-en': SYSTEM,
  'en-zh': SYSTEM_EN_ZH,
};

const criterionSchema = {
  type: 'object',
  required: ['score', 'comment'],
  properties: {
    score: { type: 'integer', description: '1 to 5' },
    comment: { type: 'string' },
  },
};

const SCHEMA = closeObjects({
  type: 'object',
  required: ['scores', 'errors', 'mistranslatedWords', 'summary'],
  properties: {
    scores: {
      type: 'object',
      required: [...CRITERIA],
      properties: Object.fromEntries(CRITERIA.map((c) => [c, criterionSchema])),
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'criterion',
          'severity',
          'translationSpan',
          'sourceSpan',
          'explanation',
          'suggestion',
        ],
        properties: {
          criterion: { type: 'string', enum: [...CRITERIA] },
          severity: { type: 'string', enum: ['major', 'minor'] },
          translationSpan: { type: 'string' },
          sourceSpan: { type: 'string' },
          explanation: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    mistranslatedWords: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
});

export function graderPrompt(
  { source, reference, translation }: TranslationInput,
  direction: TranslationDirection = 'zh-en',
) {
  const language = direction === 'zh-en' ? 'Chinese' : 'English';
  return `${language} source:\n${source}\n\nReference translation:\n${reference}\n\nLearner's translation:\n${translation}`;
}

interface GraderReply {
  scores: Record<Criterion, { score: number; comment: string }>;
  errors: Omit<TranslationError, 'translationStart' | 'sourceStart'>[];
  mistranslatedWords: string[];
  summary: string;
}

/** Where a quoted span is in a text: exactly, or ignoring spacing and case. */
export function findSpan(text: string, span: string): number | null {
  if (!span.trim()) return null;
  const exact = text.indexOf(span);
  if (exact >= 0) return exact;
  const loose = text.toLowerCase().indexOf(span.trim().toLowerCase());
  return loose >= 0 ? loose : null;
}

/** Checks and normalizes a reply. Throws if it lacks a criterion's score. */
export function parseGraderReply(
  reply: GraderReply,
  input: TranslationInput,
  direction: TranslationDirection = 'zh-en',
): GradingResult {
  // The Chinese text that words the learner didn't know are copied from.
  const chinese = direction === 'zh-en' ? input.source : input.reference;
  const scores = {} as GradingResult['scores'];
  for (const criterion of CRITERIA) {
    const entry = reply.scores?.[criterion];
    if (!entry || !Number.isFinite(entry.score)) {
      throw new Error(`The grader gave no ${criterion} score`);
    }
    scores[criterion] = {
      score: Math.min(5, Math.max(1, Math.round(entry.score))),
      comment: entry.comment ?? '',
    };
  }
  const errors = (reply.errors ?? []).map((e): TranslationError => ({
    criterion: CRITERIA.includes(e.criterion) ? e.criterion : 'accuracy',
    severity: e.severity === 'major' ? 'major' : 'minor',
    translationSpan: e.translationSpan ?? '',
    sourceSpan: e.sourceSpan ?? '',
    explanation: e.explanation ?? '',
    suggestion: e.suggestion ?? '',
    translationStart: findSpan(input.translation, e.translationSpan ?? ''),
    sourceStart: findSpan(input.source, e.sourceSpan ?? ''),
  }));
  const mistranslatedWords = [
    ...new Set(
      (reply.mistranslatedWords ?? [])
        .map((w) => w.trim())
        .filter((w) => w && chinese.includes(w)),
    ),
  ].slice(0, MAX_MISTRANSLATED_WORDS);
  return {
    scores,
    errors,
    summary: reply.summary ?? '',
    mistranslatedWords,
  };
}

export interface GraderOutput {
  result: GradingResult;
  model: string;
  promptVersion: string;
  usage: LlmUsage;
  costUsd: number;
}

/** Thrown when the grader's reply can't be used; carries what the call cost. */
export class GraderError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
  }
}

/** Grades one translation. Throws GraderError if the reply is unusable. */
export async function gradeTranslation(
  input: TranslationInput,
  llm: JsonLlm,
  direction: TranslationDirection = 'zh-en',
): Promise<GraderOutput> {
  const reply = await llm.create({
    model: GRADER_MODEL,
    max_tokens: 4000,
    system: SYSTEMS[direction],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: graderPrompt(input, direction) }],
  });
  const costUsd = costOf(reply.usage);
  try {
    return {
      result: parseGraderReply(replyJson<GraderReply>(reply), input, direction),
      model: GRADER_MODEL,
      promptVersion: GRADER_PROMPT_VERSIONS[direction],
      usage: reply.usage,
      costUsd,
    };
  } catch (err) {
    throw new GraderError(
      err instanceof Error ? err.message : String(err),
      costUsd,
    );
  }
}

/** Mean of the criterion scores, to one decimal. */
export function overallScore(result: Pick<GradingResult, 'scores'>): number {
  const sum = CRITERIA.reduce((n, c) => n + result.scores[c].score, 0);
  return Math.round((sum / CRITERIA.length) * 10) / 10;
}

/** MQM-style penalty (major 5, minor 1), for comparing with MQM ratings. */
export function errorPenalty(
  errors: readonly Pick<TranslationError, 'severity'>[],
): number {
  return errors.reduce((n, e) => n + (e.severity === 'major' ? 5 : 1), 0);
}

// --- API shapes ---------------------------------------------------------------

/** POST /api/translations */
export interface GradeTranslationRequest {
  passageId: string;
  /** Paragraph index (0-based) in the passage. */
  paragraph: number;
  translation: string;
}

/** A stored grading, as the client sees it. */
export interface TranslationGrading {
  _id: string;
  /** A passage (zh-en) or Translate exercise (en-zh). */
  passageId: string;
  paragraph: number;
  direction: TranslationDirection;
  translation: string;
  reference: string;
  result: GradingResult;
  /** Word IDs from mistranslatedWords that were added to the SRS. */
  addedWords: string[];
  createdAt: string;
}

export interface GradingLimits {
  /** Gradings in the last 24 hours. */
  used: number;
  dailyLimit: number;
  /** Why grading is unavailable now, or null if it's available. */
  unavailable: string | null;
}

/** GET /api/translations?passageId=ID: the user's gradings, newest first. */
export interface TranslationGradingsResponse {
  gradings: TranslationGrading[];
  limits: GradingLimits;
}

export interface GradeTranslationResponse {
  grading: TranslationGrading;
  /** With mistranslated words added to settings.addedWords. */
  user: AuthUser;
  limits: GradingLimits;
}
