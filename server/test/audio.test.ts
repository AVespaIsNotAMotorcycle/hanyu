import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AudioManifest } from '@hanyu/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { seedAudio } from '../src/audio.js';
import { AudioClipModel } from '../src/models/index.js';

describe('audio route without a session', () => {
  it('requires a session', async () => {
    expect(
      (await request(createApp()).get('/api/audio/word:hsk30-00001')).status,
    ).toBe(401);
  });
});

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

const entry = (hash: string, text: string) => ({
  hash,
  text,
  pinyin: null,
  voice: 'zh-CN-XiaoxiaoNeural',
  bytes: 3,
});

describe.skipIf(!uri)('audio', () => {
  const agent = request.agent(createApp());
  let dir: string;

  async function writeAudio(manifest: AudioManifest, files: string[]) {
    await mkdir(path.join(dir, 'clips'), { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const hash of files) {
      await writeFile(
        path.join(dir, 'clips', `${hash}.mp3`),
        Buffer.from(`mp3:${hash}`),
      );
    }
  }

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-audio-${process.pid}`,
    });
    dir = await mkdtemp(path.join(os.tmpdir(), 'hanyu-audio-'));
    await agent
      .post('/api/auth/sign-up')
      .send({ email: 'audio@example.com', password: 'long enough' });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('skips seeding when nothing is recorded', async () => {
    const logs: string[] = [];
    expect(
      await seedAudio({
        dir: path.join(dir, 'none'),
        log: (m) => logs.push(m),
      }),
    ).toEqual({ written: 0, stale: 0 });
    expect(logs[0]).toMatch(/none recorded/);
  });

  it('writes only changed clips, and prunes on request', async () => {
    await writeAudio(
      { clips: { 'word:a': entry('h1', '你'), 'word:b': entry('h2', '好') } },
      ['h1', 'h2'],
    );
    const log = () => {};
    expect(await seedAudio({ dir, log })).toEqual({ written: 2, stale: 0 });
    expect(await seedAudio({ dir, log })).toEqual({ written: 0, stale: 0 });

    await writeAudio({ clips: { 'word:a': entry('h3', '你') } }, ['h3']);
    expect(await seedAudio({ dir, log })).toEqual({ written: 1, stale: 1 });
    expect(await seedAudio({ dir, prune: true, log })).toEqual({
      written: 0,
      stale: 1,
    });
    expect(await AudioClipModel.countDocuments()).toBe(1);
  });

  it('serves a clip with an ETag, and 304 while it is unchanged', async () => {
    const res = await agent
      .get('/api/audio/word:a')
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers.etag).toBe('"h3"');
    expect((res.body as Buffer).toString()).toBe('mp3:h3');

    const again = await agent
      .get('/api/audio/word:a')
      .set('If-None-Match', '"h3"');
    expect(again.status).toBe(304);
    expect((await agent.get('/api/audio/word:zzz')).status).toBe(404);
  });
});
