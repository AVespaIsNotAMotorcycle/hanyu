// Loads data/seed into MongoDB.
// Usage: npm run seed -w server [-- --force] [-- --prune]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { connectDb } from '../db.js';
import { seedDatabase } from '../seed.js';

// Same relative path from src/scripts and dist/scripts.
const seedDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/seed',
);

await connectDb(config.mongodbUri);
try {
  await seedDatabase({
    seedDir,
    force: process.argv.includes('--force'),
    prune: process.argv.includes('--prune'),
  });
} finally {
  await mongoose.disconnect();
}
