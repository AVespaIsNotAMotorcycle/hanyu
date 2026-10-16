import { gunzipSync } from 'node:zlib';
import { decode } from '@msgpack/msgpack';

/**
 * Decodes a wordfreq "cB" file: a header followed by buckets, where bucket i
 * holds words with frequency 10^(-i/100). Returns Zipf frequencies
 * (log10 of occurrences per billion words), rounded to two decimals.
 */
export function parseWordfreq(gzipped: Uint8Array): Map<string, number> {
  const [header, ...buckets] = decode(gunzipSync(gzipped)) as [
    { format: string; version: number },
    ...string[][],
  ];
  if (header.format !== 'cB')
    throw new Error(`Unexpected wordfreq format: ${header.format}`);
  const zipf = new Map<string, number>();
  buckets.forEach((words, i) => {
    const value = Math.round((9 - i / 100) * 100) / 100;
    for (const word of words) if (!zipf.has(word)) zipf.set(word, value);
  });
  return zipf;
}
