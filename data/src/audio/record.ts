// Records clips with a few requests in flight, saving each as it arrives so
// an interrupted run picks up where it stopped.

import type { ClipSpec } from '@hanyu/shared';
import { billedCharacters, ssmlFor, type Tts } from './azure.js';
import {
  audioDir,
  clipHash,
  readManifest,
  writeClip,
  writeManifest,
} from './library.js';

const MAX_FAILURES_IN_A_ROW = 5;

export interface RecordResult {
  recorded: number;
  billedCharacters: number;
  failures: { key: string; error: string }[];
}

export async function recordClips({
  clips,
  tts,
  voice,
  root = audioDir,
  concurrency = 4,
  saveEvery = 50,
  onProgress = () => {},
}: {
  clips: readonly ClipSpec[];
  tts: Tts;
  voice: string;
  root?: string;
  concurrency?: number;
  saveEvery?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<RecordResult> {
  const manifest = readManifest(root);
  const result: RecordResult = {
    recorded: 0,
    billedCharacters: 0,
    failures: [],
  };
  let next = 0;
  let done = 0;
  // A bad key or region fails every request; stop instead of trying them all.
  let failedInARow = 0;

  async function worker() {
    while (next < clips.length) {
      const clip = clips[next++]!;
      try {
        const audio = await tts.synthesize(ssmlFor(clip, voice));
        if (!audio.length) throw new Error('Azure returned no audio');
        const hash = clipHash(clip, voice);
        writeClip(hash, audio, root);
        manifest.clips[clip.key] = {
          hash,
          text: clip.text,
          pinyin: clip.pinyin,
          voice,
          bytes: audio.length,
        };
        result.recorded++;
        result.billedCharacters += billedCharacters(clip);
        failedInARow = 0;
      } catch (err) {
        result.failures.push({
          key: clip.key,
          error: err instanceof Error ? err.message : String(err),
        });
        if (++failedInARow >= MAX_FAILURES_IN_A_ROW) next = clips.length;
      }
      done++;
      if (done % saveEvery === 0) writeManifest(manifest, root);
      onProgress(done, clips.length);
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, clips.length) }, worker),
    );
  } finally {
    writeManifest(manifest, root);
  }
  return result;
}
