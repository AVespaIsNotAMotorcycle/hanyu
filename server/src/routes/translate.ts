import { Router } from 'express';
import {
  isHskLevel,
  overallScore,
  type GradingResult,
  type TranslateExercise,
  type TranslateListResponse,
  type TranslatePrompt,
  type TranslateResponse,
} from '@hanyu/shared';
import { createGrader, gradingsFor, type GradingOptions } from '../grading.js';
import {
  TranslateExerciseModel,
  TranslationGradingModel,
} from '../models/index.js';
import { translationText } from './translations.js';

/** What learners see before grading: never the reference. */
const PROMPT_FIELDS = { level: 1, english: 1, topic: 1 } as const;

/**
 * English → Chinese translation exercises (the Translate page), graded by an
 * LLM at request time against a reference generated offline. Gradings share
 * the reading translations' log, daily limit, and budget.
 */
export function createTranslateRouter(options: GradingOptions) {
  const router = Router();
  const grader = createGrader(options);

  // ?level=N for one level; all exercises without it.
  router.get('/', async (req, res) => {
    const level = Number(req.query.level);
    if (req.query.level !== undefined && !isHskLevel(level)) {
      res.status(400).json({ error: 'level must be 1 to 7' });
      return;
    }
    const exercises = await TranslateExerciseModel.find(
      req.query.level === undefined ? {} : { level },
      PROMPT_FIELDS,
    )
      .sort({ _id: 1 })
      .lean<TranslatePrompt[]>();
    const gradings = await TranslationGradingModel.find(
      {
        userId: req.user!._id,
        passageId: { $in: exercises.map((e) => e._id) },
        status: 'graded',
      },
      { passageId: 1, 'result.scores': 1 },
    ).lean<{ passageId: string; result: Pick<GradingResult, 'scores'> }[]>();
    const progress = new Map<string, { gradings: number; best: number }>();
    for (const g of gradings) {
      const p = progress.get(g.passageId) ?? { gradings: 0, best: 0 };
      p.gradings++;
      p.best = Math.max(p.best, overallScore(g.result));
      progress.set(g.passageId, p);
    }
    const body: TranslateListResponse = {
      exercises: exercises.map((e) => ({
        _id: e._id,
        level: e.level,
        english: e.english,
        topic: e.topic,
        progress: progress.get(e._id) ?? { gradings: 0, best: null },
      })),
    };
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    const exercise = await TranslateExerciseModel.findById(
      req.params.id,
      PROMPT_FIELDS,
    ).lean<TranslatePrompt>();
    if (!exercise) {
      res.status(404).json({ error: 'No such exercise' });
      return;
    }
    const user = req.user!;
    const body: TranslateResponse = {
      exercise: {
        _id: exercise._id,
        level: exercise.level,
        english: exercise.english,
        topic: exercise.topic,
      },
      gradings: await gradingsFor(user._id, exercise._id),
      limits: await grader.limits(user),
    };
    res.json(body);
  });

  // Body: GradeTranslateRequest. Replies with GradeTranslationResponse.
  router.post('/:id/gradings', async (req, res) => {
    const text = translationText(req.body?.translation);
    const exercise = await TranslateExerciseModel.findById(req.params.id, {
      english: 1,
      reference: 1,
      tokens: 1,
    }).lean<
      Pick<TranslateExercise, '_id' | 'english' | 'reference' | 'tokens'>
    >();
    if (!exercise) {
      res.status(404).json({ error: 'No such exercise' });
      return;
    }
    await grader.grade(res, {
      user: req.user!,
      passageId: exercise._id,
      paragraph: 0,
      direction: 'en-zh',
      source: exercise.english,
      reference: exercise.reference,
      tokens: exercise.tokens,
      translation: text,
    });
  });

  return router;
}
