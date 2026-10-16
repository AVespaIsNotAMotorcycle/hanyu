import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CharacterNote, GrammarPoint, WordNote } from '@hanyu/shared';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CharacterModel,
  GrammarPointModel,
  ReviewLogModel,
  WordModel,
} from '../src/models/index.js';
import { seedDatabase } from '../src/seed.js';

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

const word = (n: number, simplified: string): WordNote => ({
  _id: `hsk30-${String(n).padStart(5, '0')}`,
  hskId: n,
  level: 1,
  levelLabel: '1',
  simplified,
  traditional: simplified,
  traditionalVariants: [],
  homograph: null,
  pinyin: 'ài',
  citationPinyin: 'ai4',
  alternatePinyin: [],
  syllables: [{ simplified, traditional: simplified, pinyin: 'ai4' }],
  partsOfSpeech: ['动'],
  definitions: ['to love'],
  zipf: 5,
  levelOrder: n,
  characters: [simplified],
  cedictMatch: 'exact',
});

const character: CharacterNote = {
  _id: '爱',
  traditional: ['愛'],
  readings: ['ai4'],
  introLevel: 1,
  introducedBy: 'hsk30-00001',
  introOrder: 1,
  hskReadLevel: 1,
  hskWriteLevel: 2,
};

const grammar: GrammarPoint = {
  _id: 'g1-001',
  level: 1,
  order: 1,
  category: '语素',
  name: '前缀',
  item: '',
  content: '小—、第—',
};

async function writeDataset(
  dir: string,
  words: WordNote[],
  contentHash: string,
) {
  const files: Record<string, unknown> = {
    'manifest.json': {
      version: '0.0.0-test',
      contentHash,
      sources: [],
      counts: {},
    },
    'words.json': words,
    'characters.json': [character],
    'character-details.json': [
      {
        _id: '爱',
        definition: 'love',
        radical: '爫',
        decomposition: '⿱爫友',
        etymology: null,
      },
    ],
    'strokes.json': [
      {
        _id: '爱',
        strokes: ['M 1 2 L 3 4'],
        medians: [
          [
            [1, 2],
            [3, 4],
          ],
        ],
      },
    ],
    'grammar.json': [grammar],
  };
  for (const [file, data] of Object.entries(files)) {
    await writeFile(path.join(dir, file), JSON.stringify(data));
  }
}

describe.skipIf(!uri)('seedDatabase', () => {
  let seedDir: string;
  const quiet = () => {};

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `hanyu-test-${process.pid}` });
    seedDir = await mkdtemp(path.join(os.tmpdir(), 'hanyu-seed-'));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await rm(seedDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
  });

  it('loads words, merged characters, and grammar points', async () => {
    await writeDataset(seedDir, [word(1, '爱'), word(2, '八')], 'hash-1');
    const result = await seedDatabase({ seedDir, log: quiet });

    expect(result.upserted).toEqual({
      words: 2,
      characters: 1,
      'grammar points': 1,
    });
    expect(await WordModel.countDocuments()).toBe(2);
    expect(await GrammarPointModel.countDocuments()).toBe(1);
    const ai = await CharacterModel.findById('爱').lean();
    expect(ai).toMatchObject({
      traditional: ['愛'],
      radical: '爫',
      strokes: ['M 1 2 L 3 4'],
    });
  });

  it('is idempotent', async () => {
    await writeDataset(seedDir, [word(1, '爱'), word(2, '八')], 'hash-1');
    await seedDatabase({ seedDir, log: quiet });

    expect((await seedDatabase({ seedDir, log: quiet })).skipped).toBe(true);
    await seedDatabase({ seedDir, force: true, log: quiet });
    expect(await WordModel.countDocuments()).toBe(2);
    expect(await CharacterModel.countDocuments()).toBe(1);
  });

  it('fails on invalid documents instead of skipping them', async () => {
    const invalid = {
      ...word(2, '八'),
      citationPinyin: undefined,
    } as unknown as WordNote;
    await writeDataset(seedDir, [word(1, '爱'), invalid], 'hash-invalid');
    await expect(seedDatabase({ seedDir, log: quiet })).rejects.toThrow(
      /citationPinyin/,
    );
  });

  it('keeps stale documents unless asked to prune', async () => {
    await writeDataset(seedDir, [word(1, '爱'), word(2, '八')], 'hash-1');
    await seedDatabase({ seedDir, log: quiet });

    await writeDataset(seedDir, [word(1, '爱')], 'hash-2');
    expect((await seedDatabase({ seedDir, log: quiet })).stale.words).toBe(1);
    expect(await WordModel.countDocuments()).toBe(2);

    await seedDatabase({ seedDir, force: true, prune: true, log: quiet });
    expect(await WordModel.countDocuments()).toBe(1);
  });
});

describe.skipIf(!uri)('ReviewLogModel', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `hanyu-test-logs-${process.pid}` });
    await ReviewLogModel.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const log = () => ({
    _id: crypto.randomUUID(),
    userId: new mongoose.Types.ObjectId(),
    cardKey: 'word:hsk30-00001:pinyin',
    rating: 3,
    reviewedAt: new Date(),
  });

  it('accepts new logs', async () => {
    const created = await ReviewLogModel.create(log());
    expect(await ReviewLogModel.findById(created._id)).not.toBeNull();
  });

  it('rejects updates', async () => {
    const created = await ReviewLogModel.create(log());
    await expect(
      ReviewLogModel.updateOne({ _id: created._id }, { rating: 1 }),
    ).rejects.toThrow(/append-only/);
    await expect(
      ReviewLogModel.findOneAndUpdate({ _id: created._id }, { rating: 1 }),
    ).rejects.toThrow(/append-only/);
    created.set('answer', 'changed');
    await expect(created.save()).rejects.toThrow(/append-only/);
  });

  it('rejects a second log with the same ID', async () => {
    const entry = log();
    await ReviewLogModel.create(entry);
    await expect(ReviewLogModel.create(entry)).rejects.toThrow(/duplicate key/);
  });
});
