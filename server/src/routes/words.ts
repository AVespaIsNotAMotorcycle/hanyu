import { Router } from 'express';
import type { WordNote, WordSampleResponse } from '@hanyu/shared';
import { WordModel } from '../models/index.js';

export const wordsRouter = Router();

// A random word at a level, for the pinyin practice drill. Stands in until
// the review queue serves real cards.
wordsRouter.get('/sample', async (req, res) => {
  const level = Number(req.query.level ?? 1);
  if (!Number.isInteger(level) || level < 1 || level > 7) {
    res.status(400).json({ error: 'level must be an integer from 1 to 7' });
    return;
  }
  const [word] = await WordModel.aggregate<WordNote>([
    { $match: { level } },
    { $sample: { size: 1 } },
    { $project: { __v: 0 } },
  ]);
  if (!word) {
    res
      .status(404)
      .json({ error: 'No words at that level (is the database seeded?)' });
    return;
  }
  const body: WordSampleResponse = { word };
  res.json(body);
});
