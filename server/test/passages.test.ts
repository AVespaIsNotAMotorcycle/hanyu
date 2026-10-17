import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Passage } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { GrammarPointModel, PassageModel } from '../src/models/index.js';
import { seedPassages } from '../src/passages.js';

describe('passage routes without a session', () => {
  it.each(['/api/passages?level=1', '/api/passages/p1-0001'])(
    'GET %s requires a session',
    async (url) => {
      expect((await request(createApp()).get(url)).status).toBe(401);
    },
  );
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

const passage = (id: string, overrides: Partial<Passage> = {}): Passage => ({
  _id: id,
  level: Number(id[1]) as 1,
  title: '买东西',
  titleEnglish: 'Shopping',
  text: '小明是大学生。\n\n他买了一本书。',
  names: ['小明'],
  grammar: [{ grammarId: 'g1-001', example: '第一天' }],
  questions: [
    {
      id: 'c1',
      type: 'choice',
      prompt: '小明是做什么的？',
      promptEnglish: 'What does Xiaoming do?',
      options: ['大学生', '老师', '医生', '学生'],
      answer: 0,
      explanation: 'He is a university student.',
    },
    {
      id: 'z1',
      type: 'cloze',
      sentence: '他买了一本＿＿。',
      answer: '书',
      alsoAccepted: [],
      hint: 'book',
    },
  ],
  verification: { tokens: 10, atOrBelowLevel: 10, share: 1, offLevel: [] },
  generation: {
    model: 'claude-sonnet-5-5',
    promptVersion: '1',
    generatedAt: '2026-10-17T00:00:00.000Z',
    attempts: 1,
    costUsd: 0.02,
  },
  ...overrides,
});

describe.skipIf(!uri)('passages', () => {
  let dir: string;
  const agent = request.agent(createApp());
  const quiet = () => {};

  async function write(p: Passage) {
    const levelDir = path.join(dir, `hsk${p.level}`);
    await mkdir(levelDir, { recursive: true });
    await writeFile(path.join(levelDir, `${p._id}.json`), JSON.stringify(p));
  }

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-passages-${process.pid}`,
    });
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'reader@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await PassageModel.deleteMany();
    await mongoose.connection.collection('datasetmeta').deleteMany({});
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'hanyu-passages-'));
  });

  it('loads passage files, skipping unchanged ones, and prunes on request', async () => {
    await write(passage('p1-0001'));
    await write(passage('p1-0002', { title: '我的家' }));
    await write(passage('p2-0001'));

    expect(await seedPassages({ dir, log: quiet })).toMatchObject({
      loaded: 3,
    });
    expect(await PassageModel.countDocuments()).toBe(3);
    expect((await seedPassages({ dir, log: quiet })).skipped).toBe(true);

    await rm(path.join(dir, 'hsk2'), { recursive: true });
    expect(await seedPassages({ dir, log: quiet })).toMatchObject({
      loaded: 2,
      stale: 1,
    });
    await seedPassages({ dir, force: true, prune: true, log: quiet });
    expect(await PassageModel.countDocuments()).toBe(2);
  });

  it('refuses a passage that fails the level check', async () => {
    await write(
      passage('p1-0001', {
        verification: {
          tokens: 10,
          atOrBelowLevel: 8,
          share: 0.8,
          offLevel: ['博物馆'],
        },
      }),
    );
    await expect(seedPassages({ dir, log: quiet })).rejects.toThrow(
      /fails the level check/,
    );
    expect(await PassageModel.countDocuments()).toBe(0);
  });

  it('works with no passages directory yet', async () => {
    expect(
      await seedPassages({ dir: path.join(dir, 'missing'), log: quiet }),
    ).toMatchObject({ loaded: 0 });
  });

  it('lists passages by level and serves one with its questions', async () => {
    await write(passage('p1-0002', { title: '我的家' }));
    await write(passage('p1-0001'));
    await write(passage('p2-0001'));
    await seedPassages({ dir, log: quiet });
    await GrammarPointModel.create({
      _id: 'g1-001',
      level: 1,
      order: 1,
      category: '语素',
      name: '前缀',
      item: '',
      content: '小—、第—',
    });

    const list = await agent.get('/api/passages').query({ level: 1 });
    expect(list.status).toBe(200);
    expect(list.body.passages).toEqual([
      {
        _id: 'p1-0001',
        level: 1,
        title: '买东西',
        titleEnglish: 'Shopping',
        length: 14,
        grammarIds: ['g1-001'],
        questionCount: 2,
      },
      expect.objectContaining({ _id: 'p1-0002', title: '我的家' }),
    ]);

    const one = await agent.get('/api/passages/p1-0001');
    expect(one.body.passage).toEqual(passage('p1-0001'));
    expect(one.body.grammarPoints).toEqual([
      expect.objectContaining({ _id: 'g1-001', name: '前缀' }),
    ]);

    expect((await agent.get('/api/passages/p9-0001')).status).toBe(404);
    expect((await agent.get('/api/passages').query({ level: 0 })).status).toBe(
      400,
    );
  });
});
