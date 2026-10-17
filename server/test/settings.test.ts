import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ReviewLogModel, WordModel } from '../src/models/index.js';

describe('PUT /api/settings without a session', () => {
  it('requires a session', async () => {
    expect(
      (await request(createApp()).put('/api/settings').send({})).status,
    ).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)('PUT /api/settings', () => {
  const agent = request.agent(createApp());

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-settings-${process.pid}`,
    });
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'settings@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('defaults to HSK 1 and 10 new cards a day', async () => {
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.settings).toEqual({
      dailyNewCards: 10,
      levels: [1],
      handwriting: { enabled: true, strokeOrder: 'strict', allowedMisses: 2 },
      addedWords: [],
    });
  });

  it('updates levels (sorted, deduplicated) and the daily limit', async () => {
    const res = await agent
      .put('/api/settings')
      .send({ levels: [3, 1, 3], dailyNewCards: 15 });
    expect(res.status).toBe(200);
    expect(res.body.user.settings).toEqual({
      dailyNewCards: 15,
      levels: [1, 3],
      handwriting: { enabled: true, strokeOrder: 'strict', allowedMisses: 2 },
      addedWords: [],
    });
  });

  it('updates handwriting settings field by field', async () => {
    await agent
      .put('/api/settings')
      .send({ handwriting: { strokeOrder: 'lenient' } });
    const res = await agent
      .put('/api/settings')
      .send({ handwriting: { allowedMisses: 0 } });
    expect(res.body.user.settings.handwriting).toEqual({
      enabled: true,
      strokeOrder: 'lenient',
      allowedMisses: 0,
    });
    const off = await agent
      .put('/api/settings')
      .send({ handwriting: { enabled: false } });
    expect(off.body.user.settings.handwriting.enabled).toBe(false);
  });

  it('rejects invalid settings without changing anything', async () => {
    const before = (await agent.get('/api/auth/me')).body.user.settings;
    for (const body of [
      { dailyNewCards: -1 },
      { dailyNewCards: 2.5 },
      { dailyNewCards: 201 },
      { levels: [0] },
      { levels: '1' },
      { handwriting: 'on' },
      { handwriting: { enabled: 'yes' } },
      { handwriting: { strokeOrder: 'loose' } },
      { handwriting: { allowedMisses: 11 } },
      { dailyNewCards: 5, handwriting: { allowedMisses: -1 } },
    ]) {
      const res = await agent.put('/api/settings').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await agent.get('/api/auth/me')).body.user.settings).toEqual(
      before,
    );
  });
});

describe('added words without a session', () => {
  it('requires a session', async () => {
    const app = createApp();
    expect(
      (await request(app).post('/api/settings/added-words').send({})).status,
    ).toBe(401);
    expect(
      (await request(app).delete('/api/settings/added-words/hsk30-00001'))
        .status,
    ).toBe(401);
  });
});

describe.skipIf(!uri)('added words', () => {
  const agent = request.agent(createApp());
  const add = (wordId: unknown) =>
    agent.post('/api/settings/added-words').send({ wordId });

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-added-${process.pid}`,
    });
    await WordModel.insertMany(
      [1, 2, 3].map((n) => ({
        _id: `hsk30-0000${n}`,
        hskId: n,
        level: 4,
        levelLabel: '4',
        simplified: `词${n}`,
        traditional: `詞${n}`,
        pinyin: 'cí',
        citationPinyin: 'ci2',
        zipf: 5,
        levelOrder: n,
        cedictMatch: 'exact',
      })),
    );
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'added@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('adds words in order, once each, and removes them', async () => {
    await add('hsk30-00002');
    await add('hsk30-00001');
    const again = await add('hsk30-00002');
    expect(again.status).toBe(200);
    expect(again.body.user.settings.addedWords).toEqual([
      'hsk30-00002',
      'hsk30-00001',
    ]);
    const removed = await agent.delete('/api/settings/added-words/hsk30-00002');
    expect(removed.body.user.settings.addedWords).toEqual(['hsk30-00001']);
  });

  it('drops words that have been started', async () => {
    const me = (await agent.get('/api/auth/me')).body.user;
    await ReviewLogModel.create({
      _id: '00000000-0000-4000-8000-000000000001',
      userId: me.id,
      cardKey: 'word:hsk30-00001:pinyin',
      rating: 3,
      reviewedAt: new Date(),
    });
    const res = await add('hsk30-00003');
    expect(res.body.user.settings.addedWords).toEqual(['hsk30-00003']);
  });

  it('rejects unknown words', async () => {
    expect((await add('hsk30-99999')).status).toBe(404);
    expect((await add(7)).status).toBe(400);
    expect((await add(undefined)).status).toBe(400);
  });
});
