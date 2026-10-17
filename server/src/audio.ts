import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AudioManifest } from '@hanyu/shared';
import { AudioClipModel } from './models/index.js';

export interface SeedAudioOptions {
  /** data/audio: manifest.json and clips/<hash>.mp3. */
  dir: string;
  /** Delete clips that are no longer in the manifest. */
  prune?: boolean;
  log?: (message: string) => void;
}

// Clips are small (a few kilobytes); this keeps each bulk write well under
// MongoDB's message size limit.
const BATCH_SIZE = 200;

/**
 * Loads recorded audio into MongoDB. Only clips whose recording changed are
 * written, so reseeding sends just the new ones. Without data/audio (as on
 * Heroku, where .slugignore drops it), there's nothing to load and the app
 * reads text aloud with the device's voice.
 */
export async function seedAudio({
  dir,
  prune = false,
  log = console.log,
}: SeedAudioOptions): Promise<{ written: number; stale: number }> {
  let manifest: AudioManifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(dir, 'manifest.json'), 'utf8'),
    ) as AudioManifest;
  } catch {
    log('  audio: none recorded (npm run audio:generate); skipped');
    return { written: 0, stale: 0 };
  }

  const loaded = new Map(
    (
      await AudioClipModel.find({}, { hash: 1 }).lean<
        { _id: string; hash: string }[]
      >()
    ).map((c) => [c._id, c.hash]),
  );
  const changed = Object.entries(manifest.clips).filter(
    ([key, entry]) => loaded.get(key) !== entry.hash,
  );
  for (let i = 0; i < changed.length; i += BATCH_SIZE) {
    const batch = changed.slice(i, i + BATCH_SIZE);
    const docs = await Promise.all(
      batch.map(async ([key, entry]) => ({
        _id: key,
        hash: entry.hash,
        voice: entry.voice,
        data: await readFile(path.join(dir, 'clips', `${entry.hash}.mp3`)),
      })),
    );
    await AudioClipModel.bulkWrite(
      docs.map((doc) => ({
        replaceOne: {
          filter: { _id: doc._id },
          replacement: doc,
          upsert: true,
        },
      })),
      // Without this, Mongoose silently skips documents that fail validation.
      { ordered: false, throwOnValidationError: true },
    );
  }

  const staleKeys = [...loaded.keys()].filter((k) => !(k in manifest.clips));
  if (prune && staleKeys.length) {
    await AudioClipModel.deleteMany({ _id: { $in: staleKeys } });
  }
  const total = Object.keys(manifest.clips).length;
  log(
    `  audio: ${changed.length} of ${total} clips written` +
      (staleKeys.length
        ? `; ${staleKeys.length} stale ${prune ? 'deleted' : 'kept (use --prune to delete)'}`
        : ''),
  );
  return { written: changed.length, stale: staleKeys.length };
}
