import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

// Signed-in behavior is covered in auth.test.ts, which needs a database.
describe('GET /api/health', () => {
  it('requires a session', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Sign in required' });
  });
});

describe('unknown API routes', () => {
  it('require a session too, so routes cannot be probed', async () => {
    const res = await request(createApp()).get('/api/nope');

    expect(res.status).toBe(401);
  });
});

describe('malformed JSON', () => {
  it('returns a JSON 400', async () => {
    const res = await request(createApp())
      .post('/api/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
