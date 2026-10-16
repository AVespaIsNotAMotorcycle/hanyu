import { describe, expect, it } from 'vitest';
import {
  comparablePinyin,
  numberedToMarked,
  stripTones,
  toneOf,
} from './pinyin.js';

describe('numberedToMarked', () => {
  it.each([
    ['xue2sheng5', 'xuésheng'],
    ['xue2 sheng5', 'xué sheng'],
    ['ai4', 'ài'],
    ['gou3', 'gǒu'],
    ['hui4', 'huì'],
    ['liu2', 'liú'],
    ['lu:4', 'lǜ'],
    ['nv3', 'nǚ'],
    ['na3 r5', 'nǎ r'],
    ['Zhong1 guo2', 'Zhōng guó'],
    ['er2', 'ér'],
    ['ng4', 'ǹg'],
    ['m2', 'ḿ'],
  ])('%s → %s', (input, expected) => {
    expect(numberedToMarked(input)).toBe(expected);
  });

  it('leaves text without tone numbers alone', () => {
    expect(numberedToMarked('ma')).toBe('ma');
  });
});

describe('stripTones', () => {
  it('removes tone marks but keeps ü', () => {
    expect(stripTones('lǜsè xuéshēng')).toBe('lüse xuesheng');
  });
});

describe('comparablePinyin', () => {
  it('ignores spacing, case, apostrophes, and hyphens', () => {
    expect(comparablePinyin('Liàn’ài')).toBe(comparablePinyin('liàn ài'));
    expect(comparablePinyin('jiāyù-hùxiǎo')).toBe('jiāyùhùxiǎo');
  });

  it('maps IPA look-alike letters', () => {
    expect(comparablePinyin('bàbɑ')).toBe('bàba');
  });
});

describe('toneOf', () => {
  it.each([
    ['mā', 1],
    ['má', 2],
    ['mǎ', 3],
    ['mà', 4],
    ['ma', 5],
    ['lǜ', 4],
    ['ǹg', 4],
  ])('%s is tone %i', (syllable, tone) => {
    expect(toneOf(syllable)).toBe(tone);
  });
});
