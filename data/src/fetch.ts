// Downloads every source into data/raw (gitignored) and checks it against
// data/sources.lock.json.
//
//   npm run fetch -w data                     download missing files and verify
//   npm run fetch -w data -- --force          re-download everything
//   npm run fetch -w data -- --update-lock    record current hashes in the lockfile

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './hash.js';
import { dataDir, rawDir, seedDir } from './paths.js';
import { licenseFiles, sources } from './sources.js';

const force = process.argv.includes('--force');
const updateLock = process.argv.includes('--update-lock');
const lockFile = path.join(dataDir, 'sources.lock.json');

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

const lock: Record<string, string> = (await exists(lockFile))
  ? JSON.parse(await readFile(lockFile, 'utf8'))
  : {};

await mkdir(rawDir, { recursive: true });
let failed = false;

for (const source of sources) {
  const file = path.join(rawDir, source.file);
  if (force || !(await exists(file))) {
    console.log(`Downloading ${source.id}`);
    await download(source.url, file);
  }
  const hash = await sha256File(file);
  if (!source.pinned) {
    console.log(`- ${source.id} ${hash} (unpinned)`);
  } else if (updateLock) {
    lock[source.id] = hash;
    console.log(`✓ ${source.id} ${hash} (locked)`);
  } else if (lock[source.id] !== hash) {
    console.error(
      `✗ ${source.id}: expected ${lock[source.id] ?? '(not in lockfile)'}, got ${hash}`,
    );
    failed = true;
  } else {
    console.log(`✓ ${source.id} ${hash}`);
  }
}

if (updateLock) {
  const sorted = Object.fromEntries(
    Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(lockFile, `${JSON.stringify(sorted, null, 2)}\n`);
}

const licenseDir = path.join(seedDir, 'LICENSES');
await mkdir(licenseDir, { recursive: true });
for (const license of licenseFiles) {
  const file = path.join(licenseDir, license.file);
  if (force || !(await exists(file))) await download(license.url, file);
}

if (failed) {
  console.error('Some sources did not match data/sources.lock.json.');
  process.exit(1);
}
