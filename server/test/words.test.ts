import type { WordNote } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { WordModel } from '../src/models/index.js';

describe('GET /api/words/sample', () => {
  it('requires a session', async () => {
    const res = await request(createApp()).get('/api/words/sample');

    expect(res.status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)('GET /api/words/sample (signed in)', () => {
  const word: WordNote = {
    _id: 'hsk30-00001',
    hskId: 1,
    level: 1,
    levelLabel: '1',
    simplified: '爱',
    traditional: '愛',
    traditionalVariants: [],
    homograph: null,
    pinyin: 'ài',
    citationPinyin: 'ai4',
    alternatePinyin: [],
    syllables: [{ simplified: '爱', traditional: '愛', pinyin: 'ai4' }],
    partsOfSpeech: ['动'],
    definitions: ['to love'],
    zipf: 5,
    levelOrder: 1,
    characters: ['爱'],
    cedictMatch: 'exact',
  };
  const agent = request.agent(createApp());

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `hanyu-test-words-${process.pid}` });
    await WordModel.create(word);
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'words@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('returns a word at the requested level', async () => {
    const res = await agent.get('/api/words/sample?level=1');

    expect(res.status).toBe(200);
    expect(res.body.word).toMatchObject({
      _id: 'hsk30-00001',
      citationPinyin: 'ai4',
    });
    expect(res.body.word).not.toHaveProperty('__v');
  });

  it('404s for a level with no words, and 400s for a bad level', async () => {
    expect((await agent.get('/api/words/sample?level=2')).status).toBe(404);
    expect((await agent.get('/api/words/sample?level=10')).status).toBe(400);
    expect((await agent.get('/api/words/sample?level=x')).status).toBe(400);
  });
});
