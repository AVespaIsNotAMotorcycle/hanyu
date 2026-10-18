import { Router } from 'express';
import type { Types } from 'mongoose';
import {
  isHanziToken,
  isHskLevel,
  paragraphs,
  type GrammarPoint,
  type Passage,
  type PassageResponse,
  type PassagesResponse,
  type PassageSummary,
  type PassageWord,
  type QuestionProgress,
  type RecordAnswerResponse,
  type WordNote,
} from '@hanyu/shared';
import {
  GrammarPointModel,
  PassageModel,
  QuestionAnswerModel,
  WordModel,
} from '../models/index.js';

// Reading passages. They're generated offline and loaded by the seed script;
// nothing here ever calls an LLM.
export const passagesRouter = Router();

/** The hanzi tokens of a passage that aren't names, with their counts. */
function wordTokens(passage: Pick<Passage, 'tokens' | 'names'>) {
  const names = new Set(passage.names);
  const counts = new Map<string, number>();
  for (const token of (passage.tokens ?? []).flat()) {
    if (isHanziToken(token) && !names.has(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

/** Word IDs by simplified form, for the given forms. */
async function wordIdsBySimplified(forms: Iterable<string>) {
  const words = await WordModel.find(
    { simplified: { $in: [...new Set(forms)] } },
    { simplified: 1 },
  )
    .sort({ level: 1, hskId: 1 })
    .lean<Pick<WordNote, '_id' | 'simplified'>[]>();
  const ids = new Map<string, string[]>();
  for (const { _id, simplified } of words) {
    ids.set(simplified, [...(ids.get(simplified) ?? []), _id]);
  }
  return ids;
}

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

/** A user's progress on each question answered, by passage. */
async function questionProgress(
  userId: Types.ObjectId,
  passageIds?: string[],
): Promise<Map<string, QuestionProgress[]>> {
  const rows = await QuestionAnswerModel.aggregate<{
    _id: { passageId: string; questionId: string };
    attempts: number;
    correct: boolean;
    lastAnsweredAt: Date;
  }>([
    {
      $match: {
        userId,
        ...(passageIds ? { passageId: { $in: passageIds } } : {}),
      },
    },
    {
      $group: {
        _id: { passageId: '$passageId', questionId: '$questionId' },
        attempts: { $sum: 1 },
        correct: { $max: '$correct' },
        lastAnsweredAt: { $max: '$createdAt' },
      },
    },
    { $sort: { '_id.passageId': 1, '_id.questionId': 1 } },
  ]);
  const byPassage = new Map<string, QuestionProgress[]>();
  for (const row of rows) {
    const list = byPassage.get(row._id.passageId) ?? [];
    list.push({
      questionId: row._id.questionId,
      attempts: row.attempts,
      correct: row.correct,
      lastAnsweredAt: row.lastAnsweredAt.toISOString(),
    });
    byPassage.set(row._id.passageId, list);
  }
  return byPassage;
}

// ?level=N for one level; all passages without it.
passagesRouter.get('/', async (req, res) => {
  const level = Number(req.query.level);
  if (req.query.level !== undefined && !isHskLevel(level)) {
    res.status(400).json({ error: 'level must be 1 to 7' });
    return;
  }
  const passages = await PassageModel.find(
    req.query.level === undefined ? {} : { level },
    {
      title: 1,
      titleEnglish: 1,
      level: 1,
      text: 1,
      names: 1,
      grammar: 1,
      questions: 1,
      tokens: 1,
      translation: 1,
    },
  )
    .sort({ _id: 1 })
    .lean<Passage[]>();
  const tokens = passages.map(wordTokens);
  const [ids, progress] = await Promise.all([
    wordIdsBySimplified(tokens.flatMap((t) => [...t.keys()])),
    questionProgress(req.user!._id),
  ]);
  const body: PassagesResponse = {
    passages: passages.map((p, i): PassageSummary => ({
      _id: p._id,
      level: p.level,
      title: p.title,
      titleEnglish: p.titleEnglish,
      length: [...paragraphs(p.text).join('')].length,
      grammarIds: [...new Set(p.grammar.map((g) => g.grammarId))],
      questionCount: p.questions.length,
      translatable: Boolean(p.translation?.length),
      vocabulary: [...tokens[i]!].map(([text, count]): PassageWord => ({
        text,
        wordIds: ids.get(text) ?? [],
        count,
      })),
      progress: summarize(p, progress.get(p._id) ?? []),
    })),
  };
  res.json(body);
});

/** Answered and right, counting only questions the passage still has. */
function summarize(
  passage: Pick<Passage, 'questions'>,
  progress: readonly QuestionProgress[],
) {
  const ids = new Set(passage.questions.map((q) => q.id));
  const current = progress.filter((p) => ids.has(p.questionId));
  return {
    answered: current.length,
    correct: current.filter((p) => p.correct).length,
  };
}

passagesRouter.get('/:id', async (req, res) => {
  const passage = await PassageModel.findById(req.params.id).lean<Passage>();
  if (!passage) {
    res.status(404).json({ error: 'No such passage' });
    return;
  }
  const [grammarPoints, words, progress] = await Promise.all([
    GrammarPointModel.find({
      _id: { $in: passage.grammar.map((g) => g.grammarId) },
    })
      .sort({ level: 1, order: 1 })
      .lean<GrammarPoint[]>(),
    WordModel.find({ simplified: { $in: [...wordTokens(passage).keys()] } })
      .sort({ level: 1, hskId: 1 })
      .lean<WordNote[]>(),
    questionProgress(req.user!._id, [passage._id]),
  ]);
  const body: PassageResponse = {
    passage,
    grammarPoints,
    words,
    progress: progress.get(passage._id) ?? [],
  };
  res.json(body);
});

// Body: RecordAnswerRequest. Records whether an answer was right; questions
// can be answered any number of times.
passagesRouter.post('/:id/answers', async (req, res) => {
  const { questionId, method, correct } = req.body ?? {};
  if (typeof questionId !== 'string') {
    throw badRequest('questionId is required');
  }
  if (typeof correct !== 'boolean')
    throw badRequest('correct must be true or false');
  const passage = await PassageModel.findById(req.params.id, {
    questions: 1,
  }).lean<Pick<Passage, '_id' | 'questions'>>();
  if (!passage) {
    res.status(404).json({ error: 'No such passage' });
    return;
  }
  const question = passage.questions.find((q) => q.id === questionId);
  if (!question) {
    res.status(404).json({ error: 'No such question' });
    return;
  }
  const methods =
    question.type === 'choice' ? ['choice'] : ['typed', 'handwriting'];
  if (!methods.includes(method)) {
    throw badRequest(`method must be ${methods.join(' or ')}`);
  }
  const userId = req.user!._id;
  await QuestionAnswerModel.create({
    userId,
    passageId: passage._id,
    questionId,
    method,
    correct,
  });
  const progress = (await questionProgress(userId, [passage._id]))
    .get(passage._id)!
    .find((p) => p.questionId === questionId)!;
  const body: RecordAnswerResponse = { progress };
  res.status(201).json(body);
});
