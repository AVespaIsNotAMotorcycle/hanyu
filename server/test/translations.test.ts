import type { JsonCall, JsonLlm, WordNote } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  PassageModel,
  TranslationGradingModel,
  WordModel,
} from '../src/models/index.js';

describe('translation routes without a session', () => {
  it.each([
    ['get', '/api/translations?passageId=p1-0001'],
    ['post', '/api/translations'],
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
    naturalness: { score: 5, comment: '' },
  },
  errors: [
    {
      criterion: 'accuracy',
      severity: 'major',
      translationSpan: 'a magazine',
      sourceSpan: '书',
      explanation: '书 is a book.',
      suggestion: 'a book',
    },
  ],
  // 买书 isn't a word: its tokens' words are added instead.
  mistranslatedWords: ['买书', '书'],
  summary: 'Nearly there.',
};

/** A fake grader: replies with `reply` (a string as is), recording calls. */
function fakeLlm(reply: unknown = graderReply) {
  const calls: JsonCall[] = [];
  const llm: JsonLlm = {
    async create(params) {
      calls.push(params);
      return {
        content: [
          {
            type: 'text',
            text: typeof reply === 'string' ? reply : JSON.stringify(reply),
          },
        ],
        usage: { input_tokens: 2000, output_tokens: 600 },
        stop_reason: 'end_turn',
      };
    },
  };
  return { llm, calls };
}

describe.skipIf(!uri)('translation grading', () => {
  const grader = fakeLlm();
  const app = createApp({
    grading: { llm: grader.llm, dailyLimit: 3, monthlyBudgetUsd: 10 },
  });
  const agent = request.agent(app);
  const grade = (body: object) => agent.post('/api/translations').send(body);
  const valid = {
    passageId: 'p1-0001',
    paragraph: 1,
    translation: 'He bought a magazine.',
  };

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-translations-${process.pid}`,
    });
    const word = (id: string, simplified: string, level: 1 | 2) =>
      ({
        _id: id,
        hskId: Number(id.slice(-5)),
        level,
        levelLabel: String(level),
        simplified,
        traditional: simplified,
        pinyin: 'x',
        citationPinyin: 'x1',
        zipf: 5,
        levelOrder: 1,
        cedictMatch: 'exact',
      }) as WordNote;
    await WordModel.insertMany([
      word('hsk30-00001', '书', 1),
      word('hsk30-00002', '买', 2),
      word('hsk30-00003', '买', 1),
    ]);
    await PassageModel.create({
      _id: 'p1-0001',
      level: 1,
      title: '买东西',
      titleEnglish: 'Shopping',
      text: '小明是大学生。\n\n他买书了。',
      names: ['小明'],
      grammar: [],
      questions: [{}],
      tokens: [
        ['小明', '是', '大学生', '。'],
        ['他', '买', '书', '了', '。'],
      ],
      translation: ['Xiaoming is a student.', 'He bought a book.'],
      verification: { tokens: 8, atOrBelowLevel: 8, share: 1, offLevel: [] },
      answerKeyCheck: { passed: true },
    });
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'translator@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await TranslationGradingModel.deleteMany();
  });

  it('grades a paragraph against its reference and logs the result', async () => {
    const res = await grade(valid);
    expect(res.status).toBe(200);
    const { grading, user, limits } = res.body;
    expect(grading).toMatchObject({
      passageId: 'p1-0001',
      paragraph: 1,
      translation: 'He bought a magazine.',
      result: {
        summary: 'Nearly there.',
        scores: { accuracy: { score: 3 } },
        errors: [{ translationSpan: 'a magazine', translationStart: 10 }],
      },
    });
    // 书, plus 买 (the lower-level homograph) from inside 买书.
    expect(grading.addedWords).toEqual(['hsk30-00003', 'hsk30-00001']);
    expect(user.settings.addedWords).toEqual(['hsk30-00003', 'hsk30-00001']);
    expect(limits).toEqual({ used: 1, dailyLimit: 3, unavailable: null });

    const prompt = grader.calls.at(-1)!.messages[0]!.content;
    expect(prompt).toContain('他买书了。');
    expect(prompt).toContain('He bought a book.');
    expect(prompt).not.toContain('小明是大学生');

    const [logged] = await TranslationGradingModel.find().lean();
    expect(logged).toMatchObject({
      status: 'graded',
      source: '他买书了。',
      reference: 'He bought a book.',
      model: 'claude-sonnet-5-5',
      promptVersion: '1',
    });
    expect(logged!.costUsd).toBeCloseTo(0.01);

    const list = await agent
      .get('/api/translations')
      .query({ passageId: 'p1-0001' });
    expect(list.body.gradings.map((g: { _id: string }) => g._id)).toEqual([
      grading._id,
    ]);

    // Grading again adds nothing new.
    expect((await grade(valid)).body.grading.addedWords).toEqual([]);
  });

  it('enforces the daily limit', async () => {
    for (let i = 0; i < 3; i++) expect((await grade(valid)).status).toBe(200);
    const res = await grade(valid);
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/all 3 gradings/);
  });

  it('stops at the monthly budget, counting every user', async () => {
    await TranslationGradingModel.create({
      userId: new mongoose.Types.ObjectId(),
      passageId: 'p1-0001',
      paragraph: 0,
      source: 's',
      reference: 'r',
      translation: 't',
      status: 'graded',
      model: 'm',
      promptVersion: '1',
      costUsd: 9.99,
    });
    const res = await grade(valid);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/budget/);
  });

  it('logs failed gradings with their cost', async () => {
    const broken = createApp({
      grading: {
        llm: fakeLlm('{"scores":').llm,
        dailyLimit: 3,
        monthlyBudgetUsd: 10,
      },
    });
    const brokenAgent = request.agent(broken);
    await brokenAgent
      .post('/api/auth/sign-in')
      .send({ email: 'translator@example.com', password: 'long enough' });
    const res = await brokenAgent.post('/api/translations').send(valid);
    expect(res.status).toBe(502);
    const [logged] = await TranslationGradingModel.find().lean();
    expect(logged).toMatchObject({ status: 'failed' });
    expect(logged!.costUsd).toBeGreaterThan(0);
  });

  it('is off without an LLM', async () => {
    const off = request.agent(createApp());
    await off
      .post('/api/auth/sign-in')
      .send({ email: 'translator@example.com', password: 'long enough' });
    expect((await off.post('/api/translations').send(valid)).status).toBe(503);
    const list = await off
      .get('/api/translations')
      .query({ passageId: 'p1-0001' });
    expect(list.body.limits.unavailable).toMatch(/isn’t set up/);
  });

  it('rejects invalid requests', async () => {
    for (const [body, status] of [
      [{ ...valid, passageId: '' }, 400],
      [{ ...valid, paragraph: -1 }, 400],
      [{ ...valid, paragraph: 5 }, 400],
      [{ ...valid, translation: '  ' }, 400],
      [{ ...valid, translation: 'x'.repeat(2001) }, 400],
      [{ ...valid, passageId: 'p9-0001' }, 404],
    ] as const) {
      expect((await grade(body)).status, JSON.stringify(body)).toBe(status);
    }
    expect((await agent.get('/api/translations')).status).toBe(400);
  });
});
