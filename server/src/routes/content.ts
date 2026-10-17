import { Router } from 'express';
import {
  HSK_LEVELS,
  isHskLevel,
  MAX_CHARACTER_LOOKUP,
  MAX_WORD_LOOKUP,
  type CharacterContent,
  type CharactersResponse,
  type DatasetResponse,
  type HskLevel,
  type WordNote,
  type WordsResponse,
} from '@hanyu/shared';
import {
  CharacterModel,
  DatasetMetaModel,
  WordModel,
} from '../models/index.js';

// Read-only word content, which clients cache in IndexedDB so they can build
// the review queue locally (and offline).
export const contentRouter = Router();

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

const WORD_FIELDS = { __v: 0 } as const;

contentRouter.get('/dataset', async (_req, res) => {
  const [meta, counts, characterCounts] = await Promise.all([
    DatasetMetaModel.findById('seed').lean(),
    WordModel.aggregate<{ _id: HskLevel; count: number }>([
      { $group: { _id: '$level', count: { $sum: 1 } } },
    ]),
    CharacterModel.aggregate<{ _id: HskLevel; count: number }>([
      { $group: { _id: '$introLevel', count: { $sum: 1 } } },
    ]),
  ]);
  const byLevel = (rows: { _id: HskLevel; count: number }[]) =>
    Object.fromEntries(
      HSK_LEVELS.map((level) => [
        level,
        rows.find((r) => r._id === level)?.count ?? 0,
      ]),
    ) as Record<HskLevel, number>;
  if (!meta) {
    res.status(503).json({ error: 'The word dataset has not been loaded' });
    return;
  }
  const body: DatasetResponse = {
    version: meta.version,
    contentHash: meta.contentHash,
    levelCounts: byLevel(counts),
    characterLevelCounts: byLevel(characterCounts),
  };
  res.json(body);
});

contentRouter.get('/words', async (req, res) => {
  const level = Number(req.query.level);
  if (!isHskLevel(level)) throw badRequest('level must be 1 to 7');
  const words = await WordModel.find({ level }, WORD_FIELDS)
    .sort({ levelOrder: 1 })
    .lean<WordNote[]>();
  const body: WordsResponse = { words };
  res.json(body);
});

contentRouter.post('/words/lookup', async (req, res) => {
  const ids: unknown = req.body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_WORD_LOOKUP ||
    !ids.every((id) => typeof id === 'string')
  ) {
    throw badRequest(
      `ids must be a list of at most ${MAX_WORD_LOOKUP} word IDs`,
    );
  }
  const words = await WordModel.find({ _id: { $in: ids } }, WORD_FIELDS).lean<
    WordNote[]
  >();
  const body: WordsResponse = { words };
  res.json(body);
});

// What handwriting cards need: readings, gloss, stroke paths and medians.
contentRouter.post('/characters/lookup', async (req, res) => {
  const ids: unknown = req.body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_CHARACTER_LOOKUP ||
    !ids.every((id) => typeof id === 'string')
  ) {
    throw badRequest(
      `ids must be a list of at most ${MAX_CHARACTER_LOOKUP} characters`,
    );
  }
  const characters = await CharacterModel.find(
    { _id: { $in: ids } },
    {
      traditional: 1,
      readings: 1,
      introLevel: 1,
      definition: 1,
      strokes: 1,
      medians: 1,
    },
  ).lean<CharacterContent[]>();
  const body: CharactersResponse = { characters };
  res.json(body);
});
