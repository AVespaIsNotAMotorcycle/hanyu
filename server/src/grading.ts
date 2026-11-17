// Translation grading at request time, in either direction: the daily limit
// and monthly budget (shared by every grading), the log of each call, and
// adding missed words to the learner's SRS. The only LLM calls the web app
// makes go through here.

import type { Response } from 'express';
import {
  gradeTranslation,
  GRADER_MODEL,
  GRADER_PROMPT_VERSIONS,
  GraderError,
  isHanziToken,
  type GradeTranslationResponse,
  type GradingLimits,
  type GradingResult,
  type JsonLlm,
  type TranslationDirection,
  type TranslationGrading,
  type WordNote,
} from '@hanyu/shared';
import type { Types } from 'mongoose';
import { addWords } from './addedWords.js';
import { TranslationGradingModel, WordModel } from './models/index.js';
import { toAuthUser, type UserDocument } from './models/user.js';

export interface GradingOptions {
  /** The grader's LLM client; null turns grading off (no API key). */
  llm: JsonLlm | null;
  /** Gradings per user in any 24 hours, in both directions together. */
  dailyLimit: number;
  /** Spending cap across all users per calendar month (UTC). */
  monthlyBudgetUsd: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** What a grading may cost, for checking the budget before a call. */
const GRADING_ESTIMATE_USD = 0.03;

function monthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface StoredGrading {
  _id: Types.ObjectId;
  passageId: string;
  paragraph: number;
  direction?: TranslationDirection;
  translation: string;
  reference: string;
  result: GradingResult;
  addedWords: string[];
  createdAt: Date;
}

export function toGrading(doc: StoredGrading): TranslationGrading {
  return {
    _id: String(doc._id),
    passageId: doc.passageId,
    paragraph: doc.paragraph,
    direction: doc.direction ?? 'zh-en',
    translation: doc.translation,
    reference: doc.reference,
    result: doc.result,
    addedWords: doc.addedWords ?? [],
    createdAt: doc.createdAt.toISOString(),
  };
}

/** A user's graded translations of one exercise, newest first. */
export async function gradingsFor(
  userId: Types.ObjectId,
  passageId: string,
): Promise<TranslationGrading[]> {
  const docs = await TranslationGradingModel.find({
    userId,
    passageId,
    status: 'graded',
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean<StoredGrading[]>();
  return docs.map(toGrading);
}

/**
 * The words a grader named as missed, as word IDs: an HSK word with that
 * form (the lowest level, for homographs), or else the HSK words among the
 * Chinese text's tokens inside it.
 */
async function wordIdsFor(
  words: readonly string[],
  tokens: readonly string[],
): Promise<string[]> {
  const candidates = new Set(words);
  for (const word of words) {
    for (const token of tokens) {
      if (isHanziToken(token) && word.includes(token)) candidates.add(token);
    }
  }
  const notes = await WordModel.find(
    { simplified: { $in: [...candidates] } },
    { simplified: 1 },
  )
    .sort({ level: 1, hskId: 1 })
    .lean<Pick<WordNote, '_id' | 'simplified'>[]>();
  const first = new Map<string, string>();
  for (const note of notes) {
    if (!first.has(note.simplified)) first.set(note.simplified, note._id);
  }
  return words.flatMap((word) =>
    first.has(word)
      ? [first.get(word)!]
      : tokens
          .filter((t) => isHanziToken(t) && word.includes(t) && first.has(t))
          .map((t) => first.get(t)!),
  );
}

export interface GradeRequest {
  user: UserDocument;
  passageId: string;
  paragraph: number;
  direction: TranslationDirection;
  source: string;
  reference: string;
  /** The Chinese text's tokens (source or reference), to find missed words. */
  tokens: readonly string[];
  translation: string;
}

export function createGrader(options: GradingOptions) {
  async function limits(user: UserDocument): Promise<GradingLimits> {
    const now = new Date();
    const [used, [spent]] = await Promise.all([
      TranslationGradingModel.countDocuments({
        userId: user._id,
        createdAt: { $gte: new Date(now.getTime() - DAY_MS) },
      }),
      TranslationGradingModel.aggregate<{ total: number }>([
        { $match: { createdAt: { $gte: monthStart(now) } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ]),
    ]);
    let unavailable: string | null = null;
    if (!options.llm) {
      unavailable = 'Translation grading isn’t set up on this server.';
    } else if (used >= options.dailyLimit) {
      unavailable = `You’ve used all ${options.dailyLimit} gradings for the last 24 hours. Try again later.`;
    } else if (
      (spent?.total ?? 0) + GRADING_ESTIMATE_USD >
      options.monthlyBudgetUsd
    ) {
      unavailable =
        'This month’s grading budget is used up. Grading resumes next month.';
    }
    return { used, dailyLimit: options.dailyLimit, unavailable };
  }

  /**
   * Grades a translation and replies with GradeTranslationResponse, or with
   * an error: 429 (daily limit), 503 (off, or over budget), 502 (the grader
   * failed). Every attempt is logged, before and after the call.
   */
  async function grade(res: Response, request: GradeRequest) {
    const { user, direction, source, reference } = request;
    const translation = request.translation.trim();
    const before = await limits(user);
    if (before.unavailable) {
      res
        .status(
          !options.llm ? 503 : before.used >= before.dailyLimit ? 429 : 503,
        )
        .json({ error: before.unavailable });
      return;
    }

    // Logged before the call, so it counts against the limit right away.
    const doc = await TranslationGradingModel.create({
      userId: user._id,
      passageId: request.passageId,
      paragraph: request.paragraph,
      direction,
      source,
      reference,
      translation,
      status: 'pending',
      model: GRADER_MODEL,
      promptVersion: GRADER_PROMPT_VERSIONS[direction],
    });
    let output;
    try {
      output = await gradeTranslation(
        { source, reference, translation },
        options.llm!,
        direction,
      );
    } catch (err) {
      doc.set({
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        costUsd: err instanceof GraderError ? err.costUsd : 0,
      });
      await doc.save();
      console.error('Translation grading failed:', err);
      res.status(502).json({ error: 'Grading failed. Please try again.' });
      return;
    }

    // Words the learner missed go straight into their SRS queue.
    const ids = await wordIdsFor(
      output.result.mistranslatedWords,
      request.tokens,
    );
    const added = (await addWords(user, ids, { truncate: true })) ?? [];
    if (added.length) await user.save();

    doc.set({
      status: 'graded',
      result: output.result,
      usage: output.usage,
      costUsd: output.costUsd,
      addedWords: added,
    });
    await doc.save();
    const body: GradeTranslationResponse = {
      grading: toGrading(doc.toObject() as unknown as StoredGrading),
      user: toAuthUser(user),
      limits: await limits(user),
    };
    res.json(body);
  }

  return { limits, grade };
}
