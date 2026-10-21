import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ListeningExercise } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ListeningExerciseModel } from '../src/models/index.js';
import { seedListening } from '../src/passages.js';

describe('listening routes without a session', () => {
  it.each([
    '/api/listening',
    '/api/listening?level=1',
    '/api/listening/l1-0001',
  ])('GET %s requires a session', async (url) => {
    expect((await request(createApp()).get(url)).status).toBe(401);
  });

  it('POST answers requires a session', async () => {
    const res = await request(createApp())
      .post('/api/listening/l1-0001/answers')
      .send({ questionId: 'c1', method: 'choice', correct: true });
    expect(res.status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

const exercise = (
  id: string,
  overrides: Partial<ListeningExercise> = {},
): ListeningExercise => ({
  _id: id,
  level: Number(id[1]) as 1,
  text: '明天我和朋友们去商店。我们下午三点去。',
  textEnglish: 'Tomorrow my friends and I are going to the shop, at three.',
  topic: 'Plans to go shopping',
  names: [],
  grammar: [{ grammarId: 'g1-002', example: '朋友们' }],
  questions: [
    {
      id: 'c1',
      type: 'choice',
      prompt: '他们去哪儿？',
      promptEnglish: 'Where are they going?',
      options: ['商店', '学校', '医院', '饭店'],
      answer: 0,
      explanation: 'The shop.',
    },
    {
      id: 'c2',
      type: 'choice',
      prompt: '他们几点去？',
      promptEnglish: 'What time?',
      options: ['一点', '两点', '三点', '四点'],
      answer: 2,
      explanation: 'At three.',
    },
  ],
  verification: { tokens: 12, atOrBelowLevel: 12, share: 1, offLevel: [] },
  answerKeyCheck: {
    model: 'claude-sonnet-5-5',
    promptVersion: '1',
    checkedAt: '2026-10-20T00:00:00.000Z',
    passed: true,
    answers: [
      { questionId: 'c1', given: '商店', agrees: true, alternatives: [] },
      { questionId: 'c2', given: '三点', agrees: true, alternatives: [] },
    ],
    issues: [],
    costUsd: 0.005,
  },
  review: null,
  generation: {
    model: 'claude-sonnet-5-5',
    promptVersion: '1',
    generatedAt: '2026-10-20T00:00:00.000Z',
    attempts: 1,
    costUsd: 0.01,
  },
  ...overrides,
});

describe.skipIf(!uri)('listening', () => {
  let dir: string;
  const agent = request.agent(createApp());
  const quiet = () => {};

  async function write(e: ListeningExercise) {
    const levelDir = path.join(dir, `hsk${e.level}`);
    await mkdir(levelDir, { recursive: true });
    await writeFile(path.join(levelDir, `${e._id}.json`), JSON.stringify(e));
  }

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-listening-${process.pid}`,
    });
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'listener@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await ListeningExerciseModel.deleteMany();
    await mongoose.connection.collection('datasetmeta').deleteMany({});
    await mongoose.connection.collection('questionanswers').deleteMany({});
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'hanyu-listening-'));
  });

  it('loads exercise files, skipping unchanged ones, and prunes on request', async () => {
    await write(exercise('l1-0001'));
    await write(exercise('l2-0001'));
    expect(await seedListening({ dir, log: quiet })).toMatchObject({
      loaded: 2,
    });
    expect((await seedListening({ dir, log: quiet })).skipped).toBe(true);
    await rm(path.join(dir, 'hsk2'), { recursive: true });
    await seedListening({ dir, prune: true, log: quiet });
    expect(await ListeningExerciseModel.countDocuments()).toBe(1);
  });

  it('refuses exercises that fail the level or answer-key check', async () => {
    await write(
      exercise('l1-0001', {
        verification: {
          tokens: 10,
          atOrBelowLevel: 8,
          share: 0.8,
          offLevel: [],
        },
      }),
    );
    await expect(seedListening({ dir, log: quiet })).rejects.toThrow(
      /fails the level check/,
    );
    await write(exercise('l1-0001', { answerKeyCheck: null }));
    await expect(seedListening({ dir, log: quiet })).rejects.toThrow(
      /hasn't been checked; run npm run listening:check/,
    );
    const failed = exercise('l1-0001');
    failed.answerKeyCheck!.passed = false;
    await write(failed);
    await expect(seedListening({ dir, log: quiet })).rejects.toThrow(
      /failed the answer-key check/,
    );
    expect(await ListeningExerciseModel.countDocuments()).toBe(0);
  });

  it('lists exercises without their text and serves one whole', async () => {
    await write(exercise('l1-0002'));
    await write(exercise('l1-0001'));
    await write(exercise('l2-0001'));
    await seedListening({ dir, log: quiet });

    const list = await agent.get('/api/listening').query({ level: 1 });
    expect(list.status).toBe(200);
    expect(list.body.exercises).toEqual([
      {
        _id: 'l1-0001',
        level: 1,
        questionCount: 2,
        progress: { answered: 0, correct: 0 },
      },
      expect.objectContaining({ _id: 'l1-0002' }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain('商店');
    expect((await agent.get('/api/listening')).body.exercises).toHaveLength(3);

    const one = await agent.get('/api/listening/l1-0001');
    expect(one.body).toEqual({
      exercise: exercise('l1-0001'),
      progress: [],
    });
    expect((await agent.get('/api/listening/l9-0001')).status).toBe(404);
    expect((await agent.get('/api/listening').query({ level: 0 })).status).toBe(
      400,
    );
  });

  it('records answers and reports attempts and the best grade', async () => {
    await write(exercise('l1-0001'));
    await seedListening({ dir, log: quiet });
    const answer = (body: object, id = 'l1-0001') =>
      agent.post(`/api/listening/${id}/answers`).send(body);

    const wrong = await answer({
      questionId: 'c1',
      method: 'choice',
      correct: false,
    });
    expect(wrong.status).toBe(201);
    expect(wrong.body.progress).toMatchObject({ attempts: 1, correct: false });
    const right = await answer({
      questionId: 'c1',
      method: 'choice',
      correct: true,
    });
    expect(right.body.progress).toMatchObject({ attempts: 2, correct: true });

    const list = await agent.get('/api/listening');
    expect(list.body.exercises[0].progress).toEqual({
      answered: 1,
      correct: 1,
    });
    expect((await agent.get('/api/listening/l1-0001')).body.progress).toEqual([
      expect.objectContaining({ questionId: 'c1', attempts: 2, correct: true }),
    ]);

    const other = request.agent(createApp());
    await other
      .post('/api/auth/sign-up')
      .send({ email: 'other-listener@example.com', password: 'long enough' });
    expect((await other.get('/api/listening/l1-0001')).body.progress).toEqual(
      [],
    );

    expect(
      (await answer({ questionId: 'c1', method: 'typed', correct: true }))
        .status,
    ).toBe(400);
    expect(
      (await answer({ questionId: 'c1', method: 'choice', correct: 'yes' }))
        .status,
    ).toBe(400);
    expect(
      (await answer({ questionId: 'x', method: 'choice', correct: true }))
        .status,
    ).toBe(404);
    expect(
      (
        await answer(
          { questionId: 'c1', method: 'choice', correct: true },
          'l9-0001',
        )
      ).status,
    ).toBe(404);
  });
});
