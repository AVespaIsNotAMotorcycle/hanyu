import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MIN_LEVEL_SHARE,
  type ListeningExercise,
  type Passage,
} from '@hanyu/shared';
import type { Model } from 'mongoose';
import {
  DatasetMetaModel,
  ListeningExerciseModel,
  PassageModel,
} from './models/index.js';

export interface SeedPassagesOptions {
  /** data/passages or data/listening: one hsk<level>/ directory per level. */
  dir: string;
  force?: boolean;
  /** Delete documents that are no longer in the directory. */
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

interface Checked {
  _id: string;
  verification: { share: number };
  answerKeyCheck: { passed: boolean } | null;
}

/**
 * Loads generated files (one hsk<level>/ directory per level) into
 * MongoDB, replacing each by _id. Skips the work when the files haven't
 * changed since the last load. Files that fail the level check or haven't
 * passed the answer-key check are refused.
 */
async function seedGenerated<T extends Checked>(
  { dir, force = false, prune = false, log = console.log }: SeedPassagesOptions,
  {
    model,
    metaId,
    noun,
    checkCommand,
    validate = () => {},
  }: {
    // Any virtuals (Mongoose adds `id`); only the document shape matters here.
    model: Model<any, any, any, any>;
    metaId: string;
    /** Plural, for the log: passages, listening exercises. */
    noun: string;
    checkCommand: string;
    /** Throws for anything else that makes a file unloadable. */
    validate?: (doc: T, file: string) => void;
  },
): Promise<{ skipped: boolean; loaded: number; stale: number }> {
  const { files, texts } = await readAll(dir);
  const hash = createHash('sha256');
  files.forEach((file, i) =>
    hash.update(path.relative(dir, file)).update(texts[i]!),
  );
  const contentHash = hash.digest('hex');

  const current = await DatasetMetaModel.findById(metaId).lean();
  if (!force && current?.contentHash === contentHash) {
    log(
      `${noun[0]!.toUpperCase()}${noun.slice(1)} are already loaded; nothing to do.`,
    );
    return { skipped: true, loaded: 0, stale: 0 };
  }

  const docs = texts.map((text) => JSON.parse(text) as T);
  for (const [i, doc] of docs.entries()) {
    if (!(doc.verification?.share >= MIN_LEVEL_SHARE)) {
      throw new Error(
        `${files[i]} fails the level check; regenerate or delete it`,
      );
    }
    if (!doc.answerKeyCheck) {
      throw new Error(`${files[i]} hasn't been checked; run ${checkCommand}`);
    }
    validate(doc, files[i]!);
    if (!doc.answerKeyCheck.passed) {
      throw new Error(
        `${files[i]} failed the answer-key check; regenerate or delete it`,
      );
    }
  }
  if (docs.length) {
    await model.bulkWrite(
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
  const staleFilter = { _id: { $nin: docs.map((p) => p._id) } };
  const stale = prune
    ? (await model.deleteMany(staleFilter)).deletedCount
    : await model.countDocuments(staleFilter);

  await DatasetMetaModel.replaceOne(
    { _id: metaId },
    {
      _id: metaId,
      version: String(docs.length),
      contentHash,
      seededAt: new Date(),
    },
    { upsert: true },
  );
  log(
    `  ${noun}: ${docs.length} loaded${stale ? `; ${stale} stale ${prune ? 'deleted' : 'kept (use --prune to delete)'}` : ''}`,
  );
  return { skipped: false, loaded: docs.length, stale };
}

/** Loads data/passages into MongoDB (see seedGenerated). */
export function seedPassages(options: SeedPassagesOptions) {
  return seedGenerated<Passage>(options, {
    model: PassageModel,
    metaId: 'passages',
    noun: 'passages',
    checkCommand: 'npm run passages:check',
    validate(passage, file) {
      if (!passage.tokens) {
        throw new Error(
          `${file} hasn't been checked; run npm run passages:check`,
        );
      }
    },
  });
}

/** Loads data/listening into MongoDB (see seedGenerated). */
export function seedListening(options: SeedPassagesOptions) {
  return seedGenerated<ListeningExercise>(options, {
    model: ListeningExerciseModel,
    metaId: 'listening',
    noun: 'listening exercises',
    checkCommand: 'npm run listening:check',
  });
}
