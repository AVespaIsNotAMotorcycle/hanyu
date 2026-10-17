import {
  replayReviews,
  type PostReviewsResponse,
  type QueueResponse,
  type ReviewInput,
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

describe('POST /api/reviews without a session', () => {
  it('requires a session', async () => {
    const res = await request(createApp())
      .post('/api/reviews')
      .send({ reviews: [] });
    expect(res.status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

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
  syllables: null,
  partsOfSpeech: [],
  definitions: ['to love'],
  zipf: 5,
  levelOrder: 1,
  characters: ['爱'],
  cedictMatch: 'exact',
};
const KEY = 'word:hsk30-00001:pinyin';

describe.skipIf(!uri)('POST /api/reviews', () => {
  let app: ReturnType<typeof createApp>;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-reviews-${process.pid}`,
    });
    await WordModel.create(word);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  async function signUp(email: string) {
    const signedIn = request.agent(app);
    await signedIn
      .post('/api/auth/sign-up')
      .send({ email, password: 'long enough' });
    return signedIn;
  }

  beforeEach(async () => {
    await Promise.all([
      UserModel.deleteMany(),
      SessionModel.deleteMany(),
      ReviewLogModel.deleteMany(),
    ]);
    app = createApp();
    agent = await signUp('reviews@example.com');
  });

  const review = (overrides: Partial<ReviewInput> = {}): ReviewInput => ({
    _id: crypto.randomUUID(),
    cardKey: KEY,
    rating: 3,
    reviewedAt: new Date().toISOString(),
    answer: 'ài',
    durationMs: 2400,
    deviceId: 'test-device',
    ...overrides,
  });

  const post = (reviews: unknown[], as = agent) =>
    as.post('/api/reviews').send({ reviews });

  it('stores logs and returns the card state replayed from them', async () => {
    const first = review({
      reviewedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });
    const second = review();

    const res = await post([second, first]);
    expect(res.status).toBe(200);
    const body = res.body as PostReviewsResponse;
    expect(body.accepted.sort()).toEqual([first._id, second._id].sort());
    expect(body.duplicates).toEqual([]);
    expect(body.cards[KEY]).toEqual(
      JSON.parse(JSON.stringify(replayReviews([first, second]))),
    );

    const stored = await ReviewLogModel.findById(first._id).lean();
    expect(stored).toMatchObject({
      cardKey: KEY,
      rating: 3,
      answer: 'ài',
      durationMs: 2400,
      deviceId: 'test-device',
    });
    expect(String(stored!.userId)).toBe(
      String((await UserModel.findOne())!._id),
    );
  });

  it('is idempotent: re-sent logs are reported, not stored twice', async () => {
    const log = review();
    await post([log]);

    const again = await post([log, review()]);
    expect(again.status).toBe(200);
    expect(again.body.duplicates).toEqual([log._id]);
    expect(again.body.accepted).toHaveLength(1);
    expect(await ReviewLogModel.countDocuments()).toBe(2);
  });

  it('survives the same batch arriving twice at once', async () => {
    const batch = [review(), review(), review()];
    const [a, b] = await Promise.all([post(batch), post(batch)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([...a.body.accepted, ...b.body.accepted].sort()).toEqual(
      batch.map((r) => r._id).sort(),
    );
    expect(await ReviewLogModel.countDocuments()).toBe(3);
  });

  it("refuses an ID that belongs to another user's log", async () => {
    const log = review();
    await post([log]);
    const other = await signUp('other@example.com');

    const res = await post([log], other);
    expect(res.status).toBe(409);
    expect(await ReviewLogModel.countDocuments()).toBe(1);
  });

  it('feeds the queue: a reviewed new card counts as introduced', async () => {
    await post([review({ rating: 1 })]);

    const queue = (await agent.get('/api/queue')).body as QueueResponse;
    expect(queue.introducedToday).toBe(1);
    expect(queue.cards[0]).toMatchObject({
      key: KEY,
      schedule: { phase: 'learning' },
    });
  });

  it.each([
    [[], /non-empty/],
    [[{ ...review(), _id: 'not-a-uuid' }], /UUID/],
    [[{ ...review(), _id: crypto.randomUUID().toUpperCase() }], /UUID/],
    [[review({ cardKey: 'word:hsk30-00001:meaning' })], /kind/],
    [[review({ cardKey: 'word:hsk30-99999:pinyin' })], /Unknown word/],
    [[review({ rating: 0 as never })], /rating/],
    [[review({ reviewedAt: 'yesterday' })], /reviewedAt/],
    [
      [review({ reviewedAt: new Date(Date.now() + 3600e3).toISOString() })],
      /future/,
    ],
    [[review({ answer: 'x'.repeat(201) })], /answer/],
    [[review({ durationMs: -1 })], /durationMs/],
  ])('rejects %j', async (reviews, message) => {
    const res = await post(reviews);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it('rejects a batch repeating an ID, storing nothing', async () => {
    const log = review();
    const res = await post([review(), log, log]);
    expect(res.status).toBe(400);
    expect(await ReviewLogModel.countDocuments()).toBe(0);
  });
});
