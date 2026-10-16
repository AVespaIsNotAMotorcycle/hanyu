import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CharacterDetails,
  CharacterNote,
  CharacterStrokes,
  DatasetManifest,
  GrammarPoint,
  WordNote,
} from '@hanyu/shared';
import type { Model } from 'mongoose';
import {
  CharacterModel,
  DatasetMetaModel,
  GrammarPointModel,
  WordModel,
} from './models/index.js';
import type { CharacterDoc } from './models/character.js';

type Manifest = DatasetManifest & { contentHash: string };

export interface SeedOptions {
  /** Directory holding the seed JSON files (data/seed). */
  seedDir: string;
  /** Seed even if this dataset version is already loaded. */
  force?: boolean;
  /** Delete content documents that are no longer in the dataset. */
  prune?: boolean;
  log?: (message: string) => void;
}

export interface SeedResult {
  skipped: boolean;
  upserted: Record<string, number>;
  stale: Record<string, number>;
}

const BATCH_SIZE = 1000;

async function readJson<T>(dir: string, file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dir, file), 'utf8')) as T;
}

/** Replaces every document by _id, and finds (or deletes) ones not in `docs`. */
async function sync<T extends { _id: string }>(
  model: Model<T>,
  docs: T[],
  prune: boolean,
): Promise<{ upserted: number; stale: number }> {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const ops = docs.slice(i, i + BATCH_SIZE).map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    }));
    await model.bulkWrite(ops as Parameters<Model<T>['bulkWrite']>[0], {
      ordered: false,
      // Without this, Mongoose silently skips documents that fail validation.
      throwOnValidationError: true,
    });
  }
  const staleFilter = { _id: { $nin: docs.map((d) => d._id) } };
  const stale = prune
    ? (await model.deleteMany(staleFilter)).deletedCount
    : await model.countDocuments(staleFilter);
  return { upserted: docs.length, stale };
}

/**
 * Loads the seed dataset into MongoDB. Idempotent: documents are replaced by
 * their stable _id, so running it twice leaves the same data. User data
 * (users, cards, review logs) is never touched.
 */
export async function seedDatabase({
  seedDir,
  force = false,
  prune = false,
  log = console.log,
}: SeedOptions): Promise<SeedResult> {
  const manifest = await readJson<Manifest>(seedDir, 'manifest.json');
  const current = await DatasetMetaModel.findById('seed').lean();
  if (!force && current?.contentHash === manifest.contentHash) {
    log(
      `Seed dataset ${manifest.version} is already loaded; nothing to do (use --force to reseed).`,
    );
    return { skipped: true, upserted: {}, stale: {} };
  }

  const [words, notes, details, strokes, grammar] = await Promise.all([
    readJson<WordNote[]>(seedDir, 'words.json'),
    readJson<CharacterNote[]>(seedDir, 'characters.json'),
    readJson<CharacterDetails[]>(seedDir, 'character-details.json'),
    readJson<CharacterStrokes[]>(seedDir, 'strokes.json'),
    readJson<GrammarPoint[]>(seedDir, 'grammar.json'),
  ]);

  const detailsById = new Map(details.map((d) => [d._id, d]));
  const strokesById = new Map(strokes.map((s) => [s._id, s]));
  const characters: CharacterDoc[] = notes.map((note) => {
    const d = detailsById.get(note._id);
    const s = strokesById.get(note._id);
    return {
      ...note,
      definition: d?.definition ?? null,
      radical: d?.radical ?? null,
      decomposition: d?.decomposition ?? null,
      etymology: d?.etymology ?? null,
      strokes: s?.strokes ?? [],
      medians: s?.medians ?? [],
    };
  });

  await Promise.all(
    [WordModel, CharacterModel, GrammarPointModel].map((m) => m.syncIndexes()),
  );

  const result: SeedResult = { skipped: false, upserted: {}, stale: {} };
  const steps: [string, () => Promise<{ upserted: number; stale: number }>][] =
    [
      ['words', () => sync(WordModel, words, prune)],
      ['characters', () => sync(CharacterModel, characters, prune)],
      ['grammar points', () => sync(GrammarPointModel, grammar, prune)],
    ];
  for (const [name, run] of steps) {
    const { upserted, stale } = await run();
    result.upserted[name] = upserted;
    result.stale[name] = stale;
    const staleNote = stale
      ? `; ${stale} stale ${prune ? 'deleted' : 'kept (use --prune to delete)'}`
      : '';
    log(`  ${name}: ${upserted} upserted${staleNote}`);
  }

  await DatasetMetaModel.replaceOne(
    { _id: 'seed' },
    {
      _id: 'seed',
      version: manifest.version,
      contentHash: manifest.contentHash,
      seededAt: new Date(),
    },
    { upsert: true },
  );
  log(`Seed dataset ${manifest.version} loaded.`);
  return result;
}
