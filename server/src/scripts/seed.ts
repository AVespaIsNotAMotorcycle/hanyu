// Loads data/seed, data/passages, and data/audio (if recorded) into MongoDB.
// Usage: npm run seed -w server [-- --force] [-- --prune]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { seedAudio } from '../audio.js';
import { config } from '../config.js';
import { connectDb } from '../db.js';
import { seedPassages } from '../passages.js';
import { seedDatabase } from '../seed.js';

// Same relative paths from src/scripts and dist/scripts.
const dataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data',
);
const seedDir = path.join(dataDir, 'seed');

await connectDb(config.mongodbUri);
try {
  const force = process.argv.includes('--force');
  const prune = process.argv.includes('--prune');
  await seedDatabase({ seedDir, force, prune });
  await seedPassages({ dir: path.join(dataDir, 'passages'), force, prune });
  await seedAudio({ dir: path.join(dataDir, 'audio'), prune });
} finally {
  await mongoose.disconnect();
}
