import { Router } from 'express';
import {
  isHskLevel,
  type ListeningExercise,
  type ListeningListResponse,
  type ListeningResponse,
  type RecordAnswerResponse,
} from '@hanyu/shared';
import {
  ListeningExerciseModel,
  QuestionAnswerModel,
} from '../models/index.js';
import {
  badRequest,
  questionProgress,
  summarize,
} from '../questionProgress.js';

// Listening exercises. They're generated and recorded offline and loaded by
// the seed script; nothing here ever calls an LLM or synthesizes speech.
export const listeningRouter = Router();

// ?level=N for one level; all exercises without it. Summaries leave out the
// text and questions, so a list never gives an exercise away.
listeningRouter.get('/', async (req, res) => {
  const level = Number(req.query.level);
  if (req.query.level !== undefined && !isHskLevel(level)) {
    res.status(400).json({ error: 'level must be 1 to 7' });
    return;
  }
  const exercises = await ListeningExerciseModel.find(
    req.query.level === undefined ? {} : { level },
    { level: 1, 'questions.id': 1 },
  )
    .sort({ _id: 1 })
    .lean<Pick<ListeningExercise, '_id' | 'level' | 'questions'>[]>();
  const progress = await questionProgress(
    req.user!._id,
    exercises.map((e) => e._id),
  );
  const body: ListeningListResponse = {
    exercises: exercises.map((e) => ({
      _id: e._id,
      level: e.level,
      questionCount: e.questions.length,
      progress: summarize(e, progress.get(e._id) ?? []),
    })),
  };
  res.json(body);
});

listeningRouter.get('/:id', async (req, res) => {
  const exercise = await ListeningExerciseModel.findById(
    req.params.id,
  ).lean<ListeningExercise>();
  if (!exercise) {
    res.status(404).json({ error: 'No such exercise' });
    return;
  }
  const progress = await questionProgress(req.user!._id, [exercise._id]);
  const body: ListeningResponse = {
    exercise,
    progress: progress.get(exercise._id) ?? [],
  };
  res.json(body);
});

// Body: RecordAnswerRequest (method 'choice'). Records whether an answer was
// right; questions can be answered any number of times.
listeningRouter.post('/:id/answers', async (req, res) => {
  const { questionId, method, correct } = req.body ?? {};
  if (typeof questionId !== 'string') {
    throw badRequest('questionId is required');
  }
  if (typeof correct !== 'boolean') {
    throw badRequest('correct must be true or false');
  }
  if (method !== 'choice') throw badRequest('method must be choice');
  const exercise = await ListeningExerciseModel.findById(req.params.id, {
    'questions.id': 1,
  }).lean<Pick<ListeningExercise, '_id' | 'questions'>>();
  if (!exercise) {
    res.status(404).json({ error: 'No such exercise' });
    return;
  }
  if (!exercise.questions.some((q) => q.id === questionId)) {
    res.status(404).json({ error: 'No such question' });
    return;
  }
  const userId = req.user!._id;
  await QuestionAnswerModel.create({
    userId,
    passageId: exercise._id,
    questionId,
    method,
    correct,
  });
  const progress = (await questionProgress(userId, [exercise._id]))
    .get(exercise._id)!
    .find((p) => p.questionId === questionId)!;
  const body: RecordAnswerResponse = { progress };
  res.status(201).json(body);
});
