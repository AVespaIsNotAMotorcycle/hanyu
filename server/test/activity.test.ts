import type { ActivityResponse } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  ListeningExerciseModel,
  PassageModel,
  QuestionAnswerModel,
  TranslationGradingModel,
} from '../src/models/index.js';

describe('GET /api/activity without a session', () => {
  it('requires a session', async () => {
    expect((await request(createApp()).get('/api/activity')).status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)('GET /api/activity', () => {
  const app = createApp();
  const agent = request.agent(app);
  const other = request.agent(app);
  const question = { id: 'q1' };
  const ids = { user: '', other: '' };

  const grading = (userId: string, status: string) => ({
    userId,
    passageId: 'p1-0001',
    paragraph: 0,
    source: '你好',
    reference: 'Hello',
    translation: 'Hi',
    status,
    model: 'test',
    promptVersion: 'test',
  });

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-activity-${process.pid}`,
    });
    const signUp = async (a: typeof agent, email: string) =>
      (
        await a
          .post('/api/auth/sign-up')
          .send({ email, password: 'long enough' })
      ).body.user.id as string;
    ids.user = await signUp(agent, 'activity@example.com');
    ids.other = await signUp(other, 'activity-other@example.com');

    // Validation is skipped: only the question IDs matter here.
    await PassageModel.collection.insertOne({
      _id: 'p1-0001' as never,
      questions: [question, { id: 'q2' }],
    });
    await ListeningExerciseModel.collection.insertOne({
      _id: 'l1-0001' as never,
      questions: [{ id: 'c1' }],
    });
    await QuestionAnswerModel.create([
      {
        userId: ids.user,
        passageId: 'p1-0001',
        questionId: 'q1',
        method: 'choice',
        correct: true,
      },
      {
        userId: ids.user,
        passageId: 'l1-0001',
        questionId: 'c1',
        method: 'choice',
        correct: false,
      },
      {
        userId: ids.other,
        passageId: 'p1-0001',
        questionId: 'q2',
        method: 'choice',
        correct: true,
      },
    ]);
    await TranslationGradingModel.create([
      grading(ids.user, 'graded'),
      grading(ids.user, 'failed'),
      grading(ids.other, 'graded'),
    ]);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it("returns only the user's answers and graded translations", async () => {
    const res = await agent.get('/api/activity');
    expect(res.status).toBe(200);
    const body = res.body as ActivityResponse;
    expect(body.answers).toHaveLength(2);
    expect(body.answers.map((a) => a.exerciseId).sort()).toEqual([
      'l1-0001',
      'p1-0001',
    ]);
    expect(body.answers[0]).toEqual({
      exerciseId: expect.any(String),
      questionId: expect.any(String),
      correct: expect.any(Boolean),
      at: expect.any(String),
    });
    expect(body.translations).toHaveLength(1);
    expect(body.questionCounts).toEqual({ 'p1-0001': 2, 'l1-0001': 1 });
  });

  it('is empty for a new user', async () => {
    const fresh = request.agent(app);
    await fresh
      .post('/api/auth/sign-up')
      .send({ email: 'activity-new@example.com', password: 'long enough' });
    const res = await fresh.get('/api/activity');
    expect(res.body).toEqual({
      answers: [],
      translations: [],
      questionCounts: {},
    });
  });
});
