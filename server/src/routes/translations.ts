import { Router } from 'express';
import {
  gradeTranslation,
  GRADER_MODEL,
  GRADER_PROMPT_VERSION,
  GraderError,
  isHanziToken,
  MAX_TRANSLATION_LENGTH,
  paragraphs,
  type GradeTranslationResponse,
  type GradingLimits,
  type GradingResult,
  type JsonLlm,
  type Passage,
  type TranslationGrading,
  type TranslationGradingsResponse,
  type WordNote,
} from '@hanyu/shared';
import type { Types } from 'mongoose';
import { addWords } from '../addedWords.js';
import {
  PassageModel,
  TranslationGradingModel,
  WordModel,
} from '../models/index.js';
import { toAuthUser, type UserDocument } from '../models/user.js';

export interface GradingOptions {
  /** The grader's LLM client; null turns grading off (no API key). */
  llm: JsonLlm | null;
  /** Gradings per user in any 24 hours. */
  dailyLimit: number;
  /** Spending cap across all users per calendar month (UTC). */
  monthlyBudgetUsd: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** What a grading may cost, for checking the budget before a call. */
const GRADING_ESTIMATE_USD = 0.03;

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

function monthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

interface StoredGrading {
  _id: Types.ObjectId;
  passageId: string;
  paragraph: number;
  translation: string;
  result: GradingResult;
  addedWords: string[];
  createdAt: Date;
}

function toGrading(doc: StoredGrading): TranslationGrading {
  return {
    _id: String(doc._id),
    passageId: doc.passageId,
    paragraph: doc.paragraph,
    translation: doc.translation,
    result: doc.result,
    addedWords: doc.addedWords ?? [],
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * The words a grader named as mistranslated, as word IDs: an HSK word with
 * that form (the lowest level, for homographs), or else the HSK words among
 * the paragraph's tokens inside it.
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

/**
 * Chinese → English translation exercises, graded by an LLM at request time
 * (the only LLM call in the web app). Every grading is logged.
 */
export function createTranslationsRouter(options: GradingOptions) {
  const router = Router();

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

  router.get('/', async (req, res) => {
    const passageId = req.query.passageId;
    if (typeof passageId !== 'string' || !passageId) {
      throw badRequest('passageId is required');
    }
    const user = req.user!;
    const docs = await TranslationGradingModel.find({
      userId: user._id,
      passageId,
      status: 'graded',
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<StoredGrading[]>();
    const body: TranslationGradingsResponse = {
      gradings: docs.map(toGrading),
      limits: await limits(user),
    };
    res.json(body);
  });

  // Body: GradeTranslationRequest.
  router.post('/', async (req, res) => {
    const { passageId, paragraph, translation } = req.body ?? {};
    if (typeof passageId !== 'string' || !passageId) {
      throw badRequest('passageId is required');
    }
    if (!Number.isInteger(paragraph) || paragraph < 0) {
      throw badRequest('paragraph must be a paragraph index');
    }
    if (
      typeof translation !== 'string' ||
      !translation.trim() ||
      translation.length > MAX_TRANSLATION_LENGTH
    ) {
      throw badRequest(
        `translation must be 1 to ${MAX_TRANSLATION_LENGTH} characters`,
      );
    }
    const passage = await PassageModel.findById(passageId, {
      text: 1,
      tokens: 1,
      translation: 1,
    }).lean<Pick<Passage, 'text' | 'tokens' | 'translation'>>();
    if (!passage) {
      res.status(404).json({ error: 'No such passage' });
      return;
    }
    const source = paragraphs(passage.text)[paragraph];
    const reference = passage.translation?.[paragraph];
    if (!source || !reference) {
      throw badRequest('That paragraph has no translation exercise');
    }

    const user = req.user!;
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
      passageId,
      paragraph,
      source,
      reference,
      translation: translation.trim(),
      status: 'pending',
      model: GRADER_MODEL,
      promptVersion: GRADER_PROMPT_VERSION,
    });
    let output;
    try {
      output = await gradeTranslation(
        { source, reference, translation: translation.trim() },
        options.llm!,
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

    // Words the learner misunderstood go straight into their SRS queue.
    const ids = await wordIdsFor(
      output.result.mistranslatedWords,
      passage.tokens?.[paragraph] ?? [],
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
  });

  return router;
}
