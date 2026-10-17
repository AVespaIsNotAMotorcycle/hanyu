import type { WordNote } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  CharacterModel,
  DatasetMetaModel,
  WordModel,
} from '../src/models/index.js';

describe('content routes without a session', () => {
  it.each([
    ['get', '/api/dataset'],
    ['get', '/api/words?level=1'],
    ['post', '/api/words/lookup'],
    ['post', '/api/characters/lookup'],
  ] as const)('%s %s requires a session', async (method, path) => {
    expect((await request(createApp())[method](path)).status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

const word = (n: number, level: 1 | 2, levelOrder: number): WordNote => ({
  _id: `hsk30-${String(n).padStart(5, '0')}`,
  hskId: n,
  level,
  levelLabel: String(level),
  simplified: `词${n}`,
  traditional: `詞${n}`,
  traditionalVariants: [],
  homograph: null,
  pinyin: 'cí',
  citationPinyin: 'ci2',
  alternatePinyin: [],
  syllables: null,
  partsOfSpeech: [],
  definitions: [`word ${n}`],
  zipf: 5,
  levelOrder,
  characters: [],
  cedictMatch: 'exact',
});

describe.skipIf(!uri)('content routes', () => {
  const agent = request.agent(createApp());

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-content-${process.pid}`,
    });
    await WordModel.insertMany([word(1, 1, 2), word(2, 1, 1), word(3, 2, 1)]);
    await CharacterModel.create({
      _id: '十',
      traditional: ['十'],
      readings: ['shi2'],
      introLevel: 1,
      introducedBy: 'hsk30-00001',
      introOrder: 1,
      definition: 'ten',
      radical: '十',
      strokes: ['M 1 2 L 3 4', 'M 5 6 L 7 8'],
      medians: [
        [
          [109, 442],
          [932, 476],
        ],
        [
          [456, 811],
          [507, -33],
        ],
      ],
    });
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'content@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('reports the dataset version and level sizes once seeded', async () => {
    expect((await agent.get('/api/dataset')).status).toBe(503);
    await DatasetMetaModel.create({
      _id: 'seed',
      version: '1.2.3',
      contentHash: 'abc',
      seededAt: new Date(),
    });

    const res = await agent.get('/api/dataset');
    expect(res.body).toEqual({
      version: '1.2.3',
      contentHash: 'abc',
      levelCounts: { 1: 2, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
      characterLevelCounts: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
    });
  });

  it('lists a level in introduction order', async () => {
    const res = await agent.get('/api/words').query({ level: 1 });
    expect(res.body.words.map((w: WordNote) => w._id)).toEqual([
      'hsk30-00002',
      'hsk30-00001',
    ]);
    expect(res.body.words[0]).not.toHaveProperty('__v');
    expect((await agent.get('/api/words').query({ level: 8 })).status).toBe(
      400,
    );
  });

  it('looks words up by ID, skipping unknown ones', async () => {
    const res = await agent
      .post('/api/words/lookup')
      .send({ ids: ['hsk30-00003', 'hsk30-99999'] });
    expect(res.body.words.map((w: WordNote) => w._id)).toEqual(['hsk30-00003']);
    expect(
      (await agent.post('/api/words/lookup').send({ ids: 'hsk30-00003' }))
        .status,
    ).toBe(400);
  });

  it('looks up characters with what handwriting cards need', async () => {
    const res = await agent
      .post('/api/characters/lookup')
      .send({ ids: ['十', '鬱'] });
    expect(res.body.characters).toEqual([
      {
        _id: '十',
        traditional: ['十'],
        readings: ['shi2'],
        introLevel: 1,
        definition: 'ten',
        strokes: ['M 1 2 L 3 4', 'M 5 6 L 7 8'],
        medians: [
          [
            [109, 442],
            [932, 476],
          ],
          [
            [456, 811],
            [507, -33],
          ],
        ],
      },
    ]);
    expect(
      (await agent.post('/api/characters/lookup').send({ ids: [1] })).status,
    ).toBe(400);
  });

  it('compresses large responses', async () => {
    const res = await agent
      .get('/api/words')
      .query({ level: 1 })
      .set('Accept-Encoding', 'gzip');
    // Tiny test payloads fall under compression's threshold; check the header
    // negotiation is in place.
    expect(res.headers.vary).toMatch(/Accept-Encoding/);
  });
});
