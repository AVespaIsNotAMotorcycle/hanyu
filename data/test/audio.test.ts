import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClipSpec } from '@hanyu/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  billedCharacters,
  createAzureTts,
  ssmlFor,
  type Tts,
} from '../src/audio/azure.js';
import {
  clipFile,
  clipHash,
  missingClips,
  readManifest,
} from '../src/audio/library.js';
import { recordClips } from '../src/audio/record.js';

const VOICE = 'zh-CN-TestNeural';
const clip = (key: string, text: string, pinyin: string | null = null) =>
  ({ key, text, pinyin }) satisfies ClipSpec;

describe('ssmlFor', () => {
  it('escapes text and forces pinyin through a SAPI phoneme', () => {
    expect(ssmlFor(clip('a', '<你&好>'), VOICE)).toContain(
      `<voice name="${VOICE}">&lt;你&amp;好&gt;</voice>`,
    );
    expect(ssmlFor(clip('b', '行', 'hang2'), VOICE)).toContain(
      '<phoneme alphabet="sapi" ph="hang 2">行</phoneme>',
    );
    expect(() => ssmlFor(clip('c', '行', 'hang'), VOICE)).toThrow(/pinyin/);
  });

  it('bills Chinese characters twice', () => {
    expect(billedCharacters(clip('a', '你好！A'))).toBe(6);
  });
});

describe('createAzureTts', () => {
  it('retries rate limits, honoring Retry-After', async () => {
    const waits: number[] = [];
    const statuses = [429, 503, 200];
    const tts = createAzureTts({
      key: 'k',
      region: 'eastus',
      wait: async (ms) => void waits.push(ms),
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(
          'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1',
        );
        expect(
          (init!.headers as Record<string, string>)[
            'Ocp-Apim-Subscription-Key'
          ],
        ).toBe('k');
        const status = statuses.shift()!;
        return new Response(status === 200 ? new Uint8Array([1, 2]) : '', {
          status,
          headers: status === 429 ? { 'Retry-After': '3' } : {},
        });
      },
    });
    expect([...(await tts.synthesize('<speak/>'))]).toEqual([1, 2]);
    expect(waits).toEqual([3000, 4000]);
  });

  it('fails at once on other errors', async () => {
    const tts = createAzureTts({
      key: 'bad',
      region: 'eastus',
      fetchImpl: async () => new Response('Unauthorized', { status: 401 }),
    });
    await expect(tts.synthesize('<speak/>')).rejects.toThrow(/401/);
  });
});

describe('recordClips', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hanyu-audio-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const fakeTts = (fail: (ssml: string) => boolean = () => false): Tts => ({
    async synthesize(ssml) {
      if (fail(ssml)) throw new Error('nope');
      return new TextEncoder().encode(ssml);
    },
  });

  it('records what is missing and saves a manifest', async () => {
    const clips = [clip('word:w1', '你好'), clip('word:w2', '行', 'hang2')];
    expect(missingClips(clips, readManifest(root), VOICE, root)).toHaveLength(
      2,
    );
    const result = await recordClips({
      clips,
      tts: fakeTts((ssml) => ssml.includes('行')),
      voice: VOICE,
      root,
    });
    expect(result.recorded).toBe(1);
    expect(result.failures.map((f) => f.key)).toEqual(['word:w2']);

    const manifest = readManifest(root);
    const hash = clipHash(clips[0]!, VOICE);
    expect(manifest.clips['word:w1']).toMatchObject({ hash, text: '你好' });
    expect(readFileSync(clipFile(hash, root), 'utf8')).toContain('你好');
    // Only the failure is left; a new voice or text means recording again.
    expect(
      missingClips(clips, manifest, VOICE, root).map((c) => c.key),
    ).toEqual(['word:w2']);
    expect(missingClips(clips, manifest, 'other', root)).toHaveLength(2);
    rmSync(clipFile(hash, root));
    expect(missingClips(clips, manifest, VOICE, root)).toHaveLength(2);
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(true);
  });

  it('stops after failing again and again', async () => {
    const clips = Array.from({ length: 20 }, (_, i) =>
      clip(`word:x${i}`, `字${i}`),
    );
    const result = await recordClips({
      clips,
      tts: fakeTts(() => true),
      voice: VOICE,
      root,
      concurrency: 1,
    });
    expect(result.failures).toHaveLength(5);
  });
});
