import { Router } from 'express';
import {
  translationCount,
  type ActivityResponse,
  type ListeningExercise,
  type Passage,
} from '@hanyu/shared';
import {
  ListeningExerciseModel,
  PassageModel,
  QuestionAnswerModel,
  TranslationGradingModel,
} from '../models/index.js';

// The learner's history that only the server has. The client adds its review
// logs and works out days and streaks in its own time zone (buildActivity).
export const activityRouter = Router();

activityRouter.get('/', async (req, res) => {
  const userId = req.user!._id;
  const [answers, gradings] = await Promise.all([
    QuestionAnswerModel.find(
      { userId },
      { passageId: 1, questionId: 1, correct: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .lean<
        {
          passageId: string;
          questionId: string;
          correct: boolean;
          createdAt: Date;
        }[]
      >(),
    TranslationGradingModel.find(
      { userId, status: 'graded' },
      { passageId: 1, paragraph: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .lean<{ passageId: string; paragraph: number; createdAt: Date }[]>(),
  ]);

  const ids = [
    ...new Set([...answers, ...gradings].map((work) => work.passageId)),
  ];
  const [passages, exercises] = await Promise.all([
    PassageModel.find(
      { _id: { $in: ids } },
      { 'questions.id': 1, text: 1, translation: 1 },
    ).lean<Pick<Passage, '_id' | 'questions' | 'text' | 'translation'>[]>(),
    ListeningExerciseModel.find(
      { _id: { $in: ids } },
      { 'questions.id': 1 },
    ).lean<Pick<ListeningExercise, '_id' | 'questions'>[]>(),
  ]);

  const body: ActivityResponse = {
    answers: answers.map((a) => ({
      exerciseId: a.passageId,
      questionId: a.questionId,
      correct: a.correct,
      at: a.createdAt.toISOString(),
    })),
    translations: gradings.map((g) => ({
      exerciseId: g.passageId,
      paragraph: g.paragraph,
      at: g.createdAt.toISOString(),
    })),
    questionCounts: Object.fromEntries(
      [...passages, ...exercises].map((e) => [e._id, e.questions.length]),
    ),
    translationCounts: Object.fromEntries(
      passages.map((p) => [p._id, translationCount(p)]),
    ),
  };
  res.json(body);
});
