import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const rawDir = path.join(dataDir, 'raw');
export const seedDir = path.join(dataDir, 'seed');
