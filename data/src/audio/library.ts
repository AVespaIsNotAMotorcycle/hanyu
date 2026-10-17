// Generated clips on disk: data/audio/clips/<hash>.mp3 and a manifest from
// clip key to file. Committed, so any checkout can seed it; `npm run db:seed`
// loads it into MongoDB.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { AUDIO_FORMAT, type AudioManifest, type ClipSpec } from '@hanyu/shared';
import { dataDir } from '../paths.js';

export type { AudioManifest };

export const audioDir = path.join(dataDir, 'audio');

/** Identifies a recording: the same inputs always give the same hash. */
export function clipHash(clip: ClipSpec, voice: string): string {
  return createHash('sha256')
    .update(JSON.stringify([voice, AUDIO_FORMAT, clip.text, clip.pinyin]))
    .digest('hex')
    .slice(0, 32);
}

export const clipFile = (hash: string, root = audioDir) =>
  path.join(root, 'clips', `${hash}.mp3`);

const manifestFile = (root: string) => path.join(root, 'manifest.json');

export function readManifest(root = audioDir): AudioManifest {
  try {
    return JSON.parse(readFileSync(manifestFile(root), 'utf8'));
  } catch {
    return { clips: {} };
  }
}

/** Written whole through a temporary file, so an interrupted run can resume. */
export function writeManifest(manifest: AudioManifest, root = audioDir) {
  mkdirSync(root, { recursive: true });
  const sorted: AudioManifest = {
    clips: Object.fromEntries(
      Object.entries(manifest.clips).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const tmp = `${manifestFile(root)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(tmp, manifestFile(root));
}

export function writeClip(hash: string, audio: Uint8Array, root = audioDir) {
  mkdirSync(path.join(root, 'clips'), { recursive: true });
  writeFileSync(clipFile(hash, root), audio);
}

/** Clips that need recording: new, changed, or with their file missing. */
export function missingClips(
  specs: readonly ClipSpec[],
  manifest: AudioManifest,
  voice: string,
  root = audioDir,
): ClipSpec[] {
  return specs.filter((spec) => {
    const entry = manifest.clips[spec.key];
    const hash = clipHash(spec, voice);
    return !entry || entry.hash !== hash || !existsSync(clipFile(hash, root));
  });
}
