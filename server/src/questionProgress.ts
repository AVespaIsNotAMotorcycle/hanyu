import type { Types } from 'mongoose';
import type { QuestionProgress } from '@hanyu/shared';
import { QuestionAnswerModel } from './models/index.js';

// Progress on reading and listening questions, derived from the
// questionanswers log.

export function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

/** A user's progress on each question answered, by passage or exercise. */
export async function questionProgress(
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

/** Answered and right, counting only questions the passage still has. */
export function summarize(
  passage: { questions: readonly { id: string }[] },
  progress: readonly QuestionProgress[],
) {
  const ids = new Set(passage.questions.map((q) => q.id));
  const current = progress.filter((p) => ids.has(p.questionId));
  return {
    answered: current.length,
    correct: current.filter((p) => p.correct).length,
  };
}
