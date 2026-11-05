import { readFile } from 'node:fs/promises';
import type { WordNote } from '@hanyu/shared';
import { describe, expect, it } from 'vitest';
import { checkOverrides, GLOSSES, overrideKey } from '../src/overrides.js';

const words = JSON.parse(
  await readFile(new URL('../seed/words.json', import.meta.url), 'utf8'),
) as WordNote[];
const entry = (hskId: number) => words.find((w) => w.hskId === hskId)!;

describe('overrides', () => {
  it('rejects an override for a word that does not exist', () => {
    expect(() => checkOverrides([{ hskId: 1, simplified: '爱' }])).toThrow(
      /unknown word/,
    );
  });

  it('are in the seed: each gloss leads its entry', () => {
    for (const word of words) {
      const gloss = GLOSSES[overrideKey(word.hskId, word.simplified)];
      if (gloss) expect(word.definitions[0]).toBe(gloss);
    }
  });

  it('give homographs their own forms and senses', () => {
    expect(entry(287)).toMatchObject({ traditional: '隻' });
    expect(entry(975)).toMatchObject({
      traditional: '只',
      definitions: expect.arrayContaining(['only; merely; just']),
    });
    expect(entry(218)).toMatchObject({ traditional: '喂' });
    expect(entry(3195)).toMatchObject({ traditional: '餵' });
    expect(entry(149)).toMatchObject({ traditional: '年' });
    expect(entry(149).definitions[0]).toBe('year');
    expect(entry(357).definitions[0]).not.toBe(entry(358).definitions[0]);
  });
});
