import { REMINDER_MESSAGE, type PushMessage } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  PushSubscriptionModel,
  QuestionAnswerModel,
  ReviewLogModel,
} from '../src/models/index.js';
import { sendReminders, type PushSender } from '../src/reminders.js';

describe('push routes without a session', () => {
  it.each([
    ['get', '/api/push/config'],
    ['put', '/api/push/subscription'],
    ['delete', '/api/push/subscription?endpoint=x'],
    ['post', '/api/push/subscription/test'],
  ] as const)('%s %s requires a session', async (method, url) => {
    expect((await request(createApp())[method](url)).status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)('daily reminders', () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1';
  const keys = { p256dh: 'key', auth: 'secret' };
  const body = (overrides: object = {}) => ({
    subscription: { endpoint, keys },
    timeZone: 'UTC',
    time: '19:00',
    ...overrides,
  });
  const at = (day: number, time = '19:00') =>
    new Date(`2026-03-${day}T${time}:00Z`);

  let outbox: { endpoint: string; message: PushMessage }[];
  let failure: unknown;
  const send: PushSender = async ({ endpoint }, message) => {
    if (failure) throw failure;
    outbox.push({ endpoint, message });
  };
  const app = createApp({ push: { publicKey: 'public-key', send } });
  const agent = request.agent(app);
  const other = request.agent(app);
  let userId: string;

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `hanyu-test-push-${process.pid}` });
    await PushSubscriptionModel.init();
    const signUp = async (a: typeof agent, email: string) =>
      (
        await a
          .post('/api/auth/sign-up')
          .send({ email, password: 'long enough' })
      ).body.user.id as string;
    userId = await signUp(agent, 'push@example.com');
    await signUp(other, 'push-other@example.com');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    outbox = [];
    failure = null;
    await PushSubscriptionModel.deleteMany();
    await ReviewLogModel.collection.deleteMany({});
    await QuestionAnswerModel.deleteMany();
  });

  const subscribe = (overrides?: object) =>
    agent.put('/api/push/subscription').send(body(overrides));

  it('serves the public key, or null when reminders are off', async () => {
    const res = await agent.get('/api/push/config');
    expect(res.body).toEqual({ publicKey: 'public-key' });
    const plain = request.agent(createApp());
    await plain
      .post('/api/auth/sign-in')
      .send({ email: 'push@example.com', password: 'long enough' });
    expect((await plain.get('/api/push/config')).body).toEqual({
      publicKey: null,
    });
    expect(
      (await plain.put('/api/push/subscription').send(body())).status,
    ).toBe(503);
  });

  it('refuses endpoints that are not push services', async () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data',
      'http://fcm.googleapis.com/fcm/send/x',
      'https://evil.example/x',
    ]) {
      const res = await subscribe({
        subscription: { endpoint: url, keys },
      });
      expect(res.status).toBe(400);
    }
    expect(await PushSubscriptionModel.countDocuments()).toBe(0);
  });

  it('validates the time and time zone', async () => {
    expect((await subscribe({ time: '25:00' })).status).toBe(400);
    expect((await subscribe({ timeZone: 'Mars/Base' })).status).toBe(400);
  });

  it('sends one reminder at the set time', async () => {
    expect((await subscribe()).status).toBe(204);
    await sendReminders(send, at(10, '18:59'));
    expect(outbox).toHaveLength(0);
    await sendReminders(send, at(10));
    await sendReminders(send, at(10, '19:01'));
    expect(outbox).toEqual([{ endpoint, message: REMINDER_MESSAGE }]);
    await sendReminders(send, at(11));
    expect(outbox).toHaveLength(2);
  });

  it('skips a learner who has already practiced that day', async () => {
    await subscribe();
    await ReviewLogModel.create({
      _id: crypto.randomUUID(),
      userId,
      cardKey: 'word:a:pinyin',
      rating: 3,
      reviewedAt: at(10, '09:00'),
    });
    await sendReminders(send, at(10));
    expect(outbox).toHaveLength(0);
    // Yesterday's practice doesn't count for today.
    await sendReminders(send, at(11));
    expect(outbox).toHaveLength(1);
  });

  it('can remind again today after the time changes, but not otherwise', async () => {
    await subscribe();
    await sendReminders(send, at(10));
    // Refreshing the same time (the client does on opening Settings) doesn't.
    await subscribe();
    await sendReminders(send, at(10, '19:05'));
    expect(outbox).toHaveLength(1);
    await subscribe({ time: '20:00' });
    await sendReminders(send, at(10, '20:00'));
    expect(outbox).toHaveLength(2);
  });

  it('forgets subscriptions the push service says are gone', async () => {
    await subscribe();
    failure = Object.assign(new Error('Gone'), { statusCode: 410 });
    await sendReminders(send, at(10));
    expect(await PushSubscriptionModel.countDocuments()).toBe(0);
  });

  it('keeps subscriptions through other failures', async () => {
    await subscribe();
    failure = Object.assign(new Error('Busy'), { statusCode: 503 });
    await sendReminders(send, at(10));
    expect(await PushSubscriptionModel.countDocuments()).toBe(1);
  });

  it('moves a device to whoever signs in on it', async () => {
    await subscribe();
    await other.put('/api/push/subscription').send(body());
    expect(await PushSubscriptionModel.countDocuments()).toBe(1);
    // The old owner can't remove or test it any more.
    await agent.delete(
      `/api/push/subscription?endpoint=${encodeURIComponent(endpoint)}`,
    );
    expect(await PushSubscriptionModel.countDocuments()).toBe(1);
    const test = await agent
      .post('/api/push/subscription/test')
      .send({ endpoint });
    expect(test.status).toBe(404);
    expect(outbox).toHaveLength(0);
  });

  it('removes and tests a user’s own device', async () => {
    await subscribe();
    const test = await agent
      .post('/api/push/subscription/test')
      .send({ endpoint });
    expect(test.status).toBe(204);
    expect(outbox).toHaveLength(1);
    await agent.delete(
      `/api/push/subscription?endpoint=${encodeURIComponent(endpoint)}`,
    );
    expect(await PushSubscriptionModel.countDocuments()).toBe(0);
  });
});
