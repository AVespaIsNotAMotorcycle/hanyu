import {
  studyDayStart,
  type HskLevel,
  type QueueResponse,
  type WordNote,
} from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  ReviewLogModel,
  SessionModel,
  UserModel,
  WordModel,
} from '../src/models/index.js';

describe('study routes without a session', () => {
  it.each([
    ['get', '/api/queue'],
    ['get', '/api/decks'],
    ['put', '/api/settings'],
  ] as const)('%s %s requires a session', async (method, path) => {
    expect((await request(createApp())[method](path)).status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

function word(n: number, level: HskLevel, levelOrder: number): WordNote {
  return {
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
  };
}

describe.skipIf(!uri)('study routes', () => {
  // Level 1 in frequency order is 3, 1, 2; level 2 is 4, 5.
  const words = [
    word(1, 1, 2),
    word(2, 1, 3),
    word(3, 1, 1),
    word(4, 2, 1),
    word(5, 2, 2),
  ];
  let agent: ReturnType<typeof request.agent>;
  let userId: string;

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `hanyu-test-study-${process.pid}` });
    await WordModel.insertMany(words);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([
      UserModel.deleteMany(),
      SessionModel.deleteMany(),
      ReviewLogModel.deleteMany(),
    ]);
    agent = request.agent(createApp());
    const res = await agent
      .post('/api/auth/sign-up')
      .send({ email: 'study@example.com', password: 'long enough' });
    userId = res.body.user.id;
  });

  const queue = async (tz = 'UTC') =>
    (await agent.get('/api/queue').query({ tz })).body as QueueResponse;

  const review = (noteId: string, minutesAgo: number, rating = 3) =>
    ReviewLogModel.create({
      _id: crypto.randomUUID(),
      userId,
      cardKey: `word:${noteId}:pinyin`,
      rating,
      reviewedAt: new Date(Date.now() - minutesAgo * 60 * 1000),
    });

  it('defaults new users to the HSK 1 deck and 10 new cards a day', async () => {
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.settings).toEqual({ dailyNewCards: 10, levels: [1] });

    const body = await queue();
    expect(body.cards.map((c) => c.word._id)).toEqual([
      'hsk30-00003',
      'hsk30-00001',
      'hsk30-00002',
    ]);
    expect(body.cards[0]).toMatchObject({
      key: 'word:hsk30-00003:pinyin',
      kind: 'pinyin',
      schedule: null,
    });
    expect(body).toMatchObject({
      dueCount: 0,
      newCount: 3,
      introducedToday: 0,
    });
  });

  it('limits new cards per day and puts due cards first', async () => {
    await agent.put('/api/settings').send({ dailyNewCards: 2 });
    // Introduced today: in its first learning step, due within 20 minutes.
    await review('hsk30-00003', 1);

    const body = await queue();
    expect(body.introducedToday).toBe(1);
    expect(
      body.cards.map((c) => [c.word._id, c.schedule?.phase ?? 'new']),
    ).toEqual([
      ['hsk30-00003', 'learning'],
      ['hsk30-00001', 'new'],
    ]);
    expect(body).toMatchObject({ dueCount: 1, newCount: 1 });
  });

  it('introduces new cards only from enabled decks', async () => {
    const res = await agent.put('/api/settings').send({ levels: [2, 2] });
    expect(res.body.user.settings.levels).toEqual([2]);

    expect((await queue()).cards.map((c) => c.word._id)).toEqual([
      'hsk30-00004',
      'hsk30-00005',
    ]);
  });

  it('keeps reviewing started cards after their deck is disabled', async () => {
    await review('hsk30-00003', 1);
    await agent.put('/api/settings').send({ levels: [] });

    const body = await queue();
    expect(body.cards.map((c) => c.word._id)).toEqual(['hsk30-00003']);
    expect(body.newCount).toBe(0);
  });

  it('starts the study day in the learner’s time zone', async () => {
    // A review just before the day's start counts toward yesterday.
    const tz = 'Asia/Shanghai';
    const dayStart = studyDayStart(new Date(), tz);
    const minutesAgo = (Date.now() - dayStart.getTime()) / 60000;
    await review('hsk30-00003', minutesAgo + 1);

    const body = await queue(tz);
    expect(body.dayStart).toBe(dayStart.toISOString());
    expect(body.introducedToday).toBe(0);
    expect(body.newCount).toBe(2);
  });

  it('reports per-deck progress', async () => {
    await review('hsk30-00003', 1);
    await review('hsk30-00004', 60 * 24 * 40); // long overdue

    const res = await agent.get('/api/decks').query({ tz: 'Asia/Shanghai' });
    expect(res.status).toBe(200);
    expect(res.body.decks.slice(0, 3)).toEqual([
      { level: 1, label: '1', enabled: true, total: 3, started: 1, due: 1 },
      { level: 2, label: '2', enabled: false, total: 2, started: 1, due: 1 },
      { level: 3, label: '3', enabled: false, total: 0, started: 0, due: 0 },
    ]);
    expect(res.body.decks.at(-1).label).toBe('7–9');
  });

  it('rejects bad time zones and settings', async () => {
    expect(
      (await agent.get('/api/queue').query({ tz: 'Mars/Olympus' })).status,
    ).toBe(400);
    for (const body of [
      { dailyNewCards: -1 },
      { dailyNewCards: 2.5 },
      { dailyNewCards: 201 },
      { levels: [0] },
      { levels: '1' },
    ]) {
      const res = await agent.put('/api/settings').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.settings).toEqual({ dailyNewCards: 10, levels: [1] });
  });
});
