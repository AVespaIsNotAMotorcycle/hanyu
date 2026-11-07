import type { GrammarPoint, GrammarResponse } from '@hanyu/shared';
import { Router } from 'express';
import { GrammarPointModel, PassageModel } from '../models/index.js';

export const grammarRouter = Router();

// The grammar points reading passages exercise. Which passages, and how they
// rank for this learner, come from the client's passage list and cards.
grammarRouter.get('/', async (_req, res) => {
  const ids = await PassageModel.distinct('grammar.grammarId');
  const points = await GrammarPointModel.find({ _id: { $in: ids } })
    .sort({ level: 1, order: 1 })
    .lean<GrammarPoint[]>();
  const body: GrammarResponse = { points };
  res.json(body);
});
