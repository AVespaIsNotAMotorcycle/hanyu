import { Router } from 'express';
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
  type WordNote,
} from '@hanyu/shared';
import { GrammarPointModel, PassageModel, WordModel } from '../models/index.js';

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
    },
  )
    .sort({ _id: 1 })
    .lean<Passage[]>();
  const tokens = passages.map(wordTokens);
  const ids = await wordIdsBySimplified(tokens.flatMap((t) => [...t.keys()]));
  const body: PassagesResponse = {
    passages: passages.map((p, i): PassageSummary => ({
      _id: p._id,
      level: p.level,
      title: p.title,
      titleEnglish: p.titleEnglish,
      length: [...paragraphs(p.text).join('')].length,
      grammarIds: [...new Set(p.grammar.map((g) => g.grammarId))],
      questionCount: p.questions.length,
      vocabulary: [...tokens[i]!].map(([text, count]): PassageWord => ({
        text,
        wordIds: ids.get(text) ?? [],
        count,
      })),
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
  const [grammarPoints, words] = await Promise.all([
    GrammarPointModel.find({
      _id: { $in: passage.grammar.map((g) => g.grammarId) },
    })
      .sort({ level: 1, order: 1 })
      .lean<GrammarPoint[]>(),
    WordModel.find({ simplified: { $in: [...wordTokens(passage).keys()] } })
      .sort({ level: 1, hskId: 1 })
      .lean<WordNote[]>(),
  ]);
  const body: PassageResponse = { passage, grammarPoints, words };
  res.json(body);
});
