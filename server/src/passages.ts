import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MIN_LEVEL_SHARE, type Passage } from '@hanyu/shared';
import { DatasetMetaModel, PassageModel } from './models/index.js';

export interface SeedPassagesOptions {
  /** data/passages: one hsk<level>/ directory per level. */
  dir: string;
  force?: boolean;
  /** Delete passages that are no longer in the directory. */
  prune?: boolean;
  log?: (message: string) => void;
}

async function readAll(
  dir: string,
): Promise<{ files: string[]; texts: string[] }> {
  let levels: string[];
  try {
    levels = (await readdir(dir)).filter((d) => /^hsk\d$/.test(d)).sort();
  } catch {
    return { files: [], texts: [] };
  }
  const files: string[] = [];
  for (const level of levels) {
    for (const file of (await readdir(path.join(dir, level))).sort()) {
      if (file.endsWith('.json')) files.push(path.join(dir, level, file));
    }
  }
  return {
    files,
    texts: await Promise.all(files.map((f) => readFile(f, 'utf8'))),
  };
}

/**
 * Loads generated passages into MongoDB, replacing each by _id. Skips the
 * work when the files haven't changed since the last load. Passages that
 * fail the level check are refused (they shouldn't have been written).
 */
export async function seedPassages({
  dir,
  force = false,
  prune = false,
  log = console.log,
}: SeedPassagesOptions): Promise<{
  skipped: boolean;
  loaded: number;
  stale: number;
}> {
  const { files, texts } = await readAll(dir);
  const hash = createHash('sha256');
  files.forEach((file, i) =>
    hash.update(path.relative(dir, file)).update(texts[i]!),
  );
  const contentHash = hash.digest('hex');

  const current = await DatasetMetaModel.findById('passages').lean();
  if (!force && current?.contentHash === contentHash) {
    log('Passages are already loaded; nothing to do.');
    return { skipped: true, loaded: 0, stale: 0 };
  }

  const passages = texts.map((text) => JSON.parse(text) as Passage);
  for (const [i, passage] of passages.entries()) {
    if (!(passage.verification?.share >= MIN_LEVEL_SHARE)) {
      throw new Error(
        `${files[i]} fails the level check; regenerate or delete it`,
      );
    }
  }
  if (passages.length) {
    await PassageModel.bulkWrite(
      passages.map((passage) => ({
        replaceOne: {
          filter: { _id: passage._id },
          replacement: passage,
          upsert: true,
        },
      })) as Parameters<typeof PassageModel.bulkWrite>[0],
      // Without this, Mongoose silently skips documents that fail validation.
      { ordered: false, throwOnValidationError: true },
    );
  }
  const staleFilter = { _id: { $nin: passages.map((p) => p._id) } };
  const stale = prune
    ? (await PassageModel.deleteMany(staleFilter)).deletedCount
    : await PassageModel.countDocuments(staleFilter);

  await DatasetMetaModel.replaceOne(
    { _id: 'passages' },
    {
      _id: 'passages',
      version: String(passages.length),
      contentHash,
      seededAt: new Date(),
    },
    { upsert: true },
  );
  log(
    `  passages: ${passages.length} loaded${stale ? `; ${stale} stale ${prune ? 'deleted' : 'kept (use --prune to delete)'}` : ''}`,
  );
  return { skipped: false, loaded: passages.length, stale };
}
