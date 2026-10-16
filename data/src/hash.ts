import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
