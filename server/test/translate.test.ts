import type { JsonCall, JsonLlm, WordNote } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  TranslateExerciseModel,
  TranslationGradingModel,
  WordModel,
} from '../src/models/index.js';

describe('translate routes without a session', () => {
  it.each([
    ['get', '/api/translate'],
    ['get', '/api/translate/t1-0001'],
    ['post', '/api/translate/t1-0001/gradings'],
  ] as const)('%s %s requires a session', async (method, path) => {
    expect((await request(createApp())[method](path)).status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

const graderReply = {
  scores: {
    accuracy: { score: 3, comment: 'One word is wrong.' },
    completeness: { score: 5, comment: '' },
    grammar: { score: 4, comment: '' },
    naturalness: { score: 4, comment: '' },
  },
  errors: [
    {
      criterion: 'accuracy',
      severity: 'major',
      translationSpan: '卖',
      sourceSpan: 'bought',
      explanation: '卖 is to sell.',
      suggestion: '买',
    },
  ],
  // 卖 isn't in the reference, so it's dropped.
  mistranslatedWords: ['买', '卖'],
  summary: 'Nearly there.',
};

function fakeLlm(reply: unknown = graderReply) {
  const calls: JsonCall[] = [];
  const llm: JsonLlm = {
    async create(params) {
      calls.push(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(reply) }],
        usage: { input_tokens: 2000, output_tokens: 600 },
        stop_reason: 'end_turn',
      };
    },
  };
  return { llm, calls };
}

describe.skipIf(!uri)('translate exercises', () => {
  const grader = fakeLlm();
  const app = createApp({
    grading: { llm: grader.llm, dailyLimit: 3, monthlyBudgetUsd: 10 },
  });
  const agent = request.agent(app);
  const grade = (id: string, translation: unknown) =>
    agent.post(`/api/translate/${id}/gradings`).send({ translation });

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-translate-${process.pid}`,
    });
    await WordModel.create({
      _id: 'hsk30-00002',
      hskId: 2,
      level: 1,
      levelLabel: '1',
      simplified: '买',
      traditional: '買',
      pinyin: 'mǎi',
      citationPinyin: 'mai3',
      zipf: 5,
      levelOrder: 1,
      cedictMatch: 'exact',
    } as WordNote);
    const exercise = (id: string, level: number, english: string) => ({
      _id: id,
      level,
      english,
      reference: '我昨天买了两本书。',
      topic: 'Shopping',
      tokens: ['我', '昨天', '买', '了', '两', '本', '书', '。'],
      grammar: [],
      verification: { tokens: 7, atOrBelowLevel: 7, share: 1, offLevel: [] },
      answerKeyCheck: { passed: true },
    });
    await TranslateExerciseModel.insertMany([
      exercise('t1-0001', 1, 'I bought two books yesterday.'),
      exercise('t2-0001', 2, 'My brother is taller than me.'),
    ]);
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'writer@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await TranslationGradingModel.deleteMany();
  });

  it('lists exercises without their references', async () => {
    const res = await agent.get('/api/translate').query({ level: 1 });
    expect(res.status).toBe(200);
    expect(res.body.exercises).toEqual([
      {
        _id: 't1-0001',
        level: 1,
        english: 'I bought two books yesterday.',
        topic: 'Shopping',
        progress: { gradings: 0, best: null },
      },
    ]);
    expect((await agent.get('/api/translate')).body.exercises).toHaveLength(2);
    expect((await agent.get('/api/translate?level=9')).status).toBe(400);

    const one = await agent.get('/api/translate/t1-0001');
    expect(one.body.exercise).not.toHaveProperty('reference');
    expect(one.body.gradings).toEqual([]);
    expect(one.body.limits).toEqual({
      used: 0,
      dailyLimit: 3,
      unavailable: null,
    });
    expect((await agent.get('/api/translate/t9-0001')).status).toBe(404);
  });

  it('grades into Chinese, adds missed words, and logs the direction', async () => {
    const res = await grade('t1-0001', ' 我昨天卖了两本书。 ');
    expect(res.status).toBe(200);
    const { grading, user, limits } = res.body;
    expect(grading).toMatchObject({
      passageId: 't1-0001',
      paragraph: 0,
      direction: 'en-zh',
      translation: '我昨天卖了两本书。',
      reference: '我昨天买了两本书。',
      result: {
        errors: [{ translationSpan: '卖', translationStart: 3 }],
        mistranslatedWords: ['买'],
      },
      addedWords: ['hsk30-00002'],
    });
    expect(user.settings.addedWords).toContain('hsk30-00002');
    expect(limits.used).toBe(1);

    const call = grader.calls.at(-1)!;
    expect(call.system).toMatch(/Chinese translations of short English/);
    expect(call.messages[0]!.content).toContain(
      'English source:\nI bought two books yesterday.',
    );
    const [logged] = await TranslationGradingModel.find().lean();
    expect(logged).toMatchObject({
      status: 'graded',
      direction: 'en-zh',
      source: 'I bought two books yesterday.',
      promptVersion: '1',
    });

    const list = await agent.get('/api/translate').query({ level: 1 });
    expect(list.body.exercises[0].progress).toEqual({ gradings: 1, best: 4 });
    const one = await agent.get('/api/translate/t1-0001');
    expect(one.body.gradings.map((g: { _id: string }) => g._id)).toEqual([
      grading._id,
    ]);

    // Counted toward the day's activity.
    const activity = await agent.get('/api/activity');
    expect(activity.body.translations).toEqual([
      expect.objectContaining({ exerciseId: 't1-0001', paragraph: 0 }),
    ]);
  });

  it('shares the daily limit with reading translations', async () => {
    await TranslationGradingModel.create({
      userId: (await agent.get('/api/auth/me')).body.user.id,
      passageId: 'p1-0001',
      paragraph: 0,
      source: 's',
      reference: 'r',
      translation: 't',
      status: 'graded',
      model: 'm',
      promptVersion: '1',
    });
    expect((await grade('t1-0001', '我')).status).toBe(200);
    expect((await grade('t1-0001', '我')).status).toBe(200);
    const res = await grade('t1-0001', '我');
    expect(res.status).toBe(429);
  });

  it('rejects invalid requests', async () => {
    expect((await grade('t1-0001', '  ')).status).toBe(400);
    expect((await grade('t1-0001', 'x'.repeat(2001))).status).toBe(400);
    expect((await grade('t1-0001', 5)).status).toBe(400);
    expect((await grade('t9-0001', '我')).status).toBe(404);
  });
});
