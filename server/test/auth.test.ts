import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { SessionModel, UserModel } from '../src/models/index.js';

const credentials = {
  email: 'Learner@Example.com',
  password: 'hunter2hunter2',
};

describe('auth validation', () => {
  // Rejected before any database access, so these run without MongoDB.
  it.each([
    [{}, /email/],
    [{ email: 'not-an-email', password: 'long enough' }, /email/],
    [{ email: 'a@b.co', password: 'short' }, /at least 8/],
    [{ email: 'a@b.co', password: 'x'.repeat(257) }, /at most 256/],
    [{ email: 'a@b.co', password: 'long enough', displayName: 5 }, /Display/],
  ])('sign-up rejects %j', async (body, message) => {
    const res = await request(createApp()).post('/api/auth/sign-up').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it('sign-in requires email and password', async () => {
    const res = await request(createApp())
      .post('/api/auth/sign-in')
      .send({ email: 'a@b.co' });

    expect(res.status).toBe(400);
  });

  it('GET /api/auth/me requires a session', async () => {
    const res = await request(createApp()).get('/api/auth/me');

    expect(res.status).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)('auth flow', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `hanyu-test-auth-${process.pid}` });
    await Promise.all([UserModel.syncIndexes(), SessionModel.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([UserModel.deleteMany(), SessionModel.deleteMany()]);
  });

  const sessionCookie = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));

  it('signs up, reaches protected routes, and signs out', async () => {
    const agent = request.agent(createApp());

    const signUp = await agent
      .post('/api/auth/sign-up')
      .send({ ...credentials, displayName: ' Sasha ' });
    expect(signUp.status).toBe(201);
    expect(signUp.body.user).toMatchObject({
      email: 'learner@example.com',
      displayName: 'Sasha',
      settings: { dailyNewCards: 10 },
    });
    expect(signUp.body.user).not.toHaveProperty('passwordHash');
    const cookie = sessionCookie(signUp);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);

    expect((await agent.get('/api/health')).status).toBe(200);
    expect((await agent.get('/api/nope')).status).toBe(404);
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.id).toBe(signUp.body.user.id);

    expect((await agent.post('/api/auth/sign-out')).status).toBe(204);
    expect(await SessionModel.countDocuments()).toBe(0);
    expect((await agent.get('/api/health')).status).toBe(401);
  });

  it('stores only a password hash and a session-token hash', async () => {
    const res = await request(createApp())
      .post('/api/auth/sign-up')
      .send(credentials);
    const token = sessionCookie(res)!.split(';')[0]!.split('=')[1]!;

    const user = await UserModel.findOne().select('+passwordHash').lean();
    expect(user!.passwordHash).toMatch(/^scrypt\$/);
    expect(user!.passwordHash).not.toContain(credentials.password);
    const session = await SessionModel.findOne().lean();
    expect(session!._id).not.toBe(token);
  });

  it('rejects a second account with the same email', async () => {
    const app = createApp();
    await request(app).post('/api/auth/sign-up').send(credentials);
    const res = await request(app)
      .post('/api/auth/sign-up')
      .send({ ...credentials, email: 'learner@example.com' });

    expect(res.status).toBe(409);
  });

  it('signs in with the right password only', async () => {
    const app = createApp();
    await request(app).post('/api/auth/sign-up').send(credentials);

    const wrong = await request(app)
      .post('/api/auth/sign-in')
      .send({ ...credentials, password: 'wrong password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'Incorrect email or password' });
    expect(sessionCookie(wrong)).toBeUndefined();

    const unknown = await request(app)
      .post('/api/auth/sign-in')
      .send({ ...credentials, email: 'nobody@example.com' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);

    const right = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: ' LEARNER@example.com ', password: credentials.password });
    expect(right.status).toBe(200);
    expect(right.body.user.email).toBe('learner@example.com');
    expect(sessionCookie(right)).toBeDefined();
  });

  it('rejects expired sessions and clears their cookie', async () => {
    const agent = request.agent(createApp());
    await agent.post('/api/auth/sign-up').send(credentials);
    await SessionModel.updateMany({}, { expiresAt: new Date(Date.now() - 1) });

    const res = await agent.get('/api/health');
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('extends a session that is in use', async () => {
    const agent = request.agent(createApp());
    await agent.post('/api/auth/sign-up').send(credentials);
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await SessionModel.updateMany({}, { expiresAt: soon });

    const res = await agent.get('/api/health');
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
    const session = await SessionModel.findOne().lean();
    expect(session!.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );
  });

  it('rate-limits repeated failed sign-ins', async () => {
    const app = createApp();
    const attempt = () =>
      request(app)
        .post('/api/auth/sign-in')
        .send({ email: 'nobody@example.com', password: 'wrong password' });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Too many/);
  });
});
