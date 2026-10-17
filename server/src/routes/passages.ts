import { Router } from 'express';
import {
  isHskLevel,
  paragraphs,
  type GrammarPoint,
  type Passage,
  type PassageResponse,
  type PassagesResponse,
  type PassageSummary,
} from '@hanyu/shared';
import { GrammarPointModel, PassageModel } from '../models/index.js';

// Reading passages. They're generated offline and loaded by the seed script;
// nothing here ever calls an LLM.
export const passagesRouter = Router();

passagesRouter.get('/', async (req, res) => {
  const level = Number(req.query.level);
  if (!isHskLevel(level)) {
    res.status(400).json({ error: 'level must be 1 to 7' });
    return;
  }
  const passages = await PassageModel.find(
    { level },
    { title: 1, titleEnglish: 1, level: 1, text: 1, grammar: 1, questions: 1 },
  )
    .sort({ _id: 1 })
    .lean<Passage[]>();
  const body: PassagesResponse = {
    passages: passages.map((p): PassageSummary => ({
      _id: p._id,
      level: p.level,
      title: p.title,
      titleEnglish: p.titleEnglish,
      length: [...paragraphs(p.text).join('')].length,
      grammarIds: [...new Set(p.grammar.map((g) => g.grammarId))],
      questionCount: p.questions.length,
    })),
  };
  res.json(body);
});

passagesRouter.get('/:id', async (req, res) => {
  const passage = await PassageModel.findById(req.params.id).lean<Passage>();
  if (!passage) {
    res.status(404).json({ error: 'No such passage' });
    return;
  }
  const grammarPoints = await GrammarPointModel.find({
    _id: { $in: passage.grammar.map((g) => g.grammarId) },
  })
    .sort({ level: 1, order: 1 })
    .lean<GrammarPoint[]>();
  const body: PassageResponse = { passage, grammarPoints };
  res.json(body);
});
