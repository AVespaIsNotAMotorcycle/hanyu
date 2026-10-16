import { describe, expect, it } from 'vitest';
import {
  citationFromSyllabus,
  composeFromParts,
  matchCedict,
} from '../src/match.js';
import type { CedictEntry } from '../src/parse/cedict.js';

const entry = (
  traditional: string,
  simplified: string,
  pinyin: string,
  ...definitions: string[]
): CedictEntry => ({
  traditional,
  simplified,
  pinyin,
  definitions: definitions.length ? definitions : ['(definition)'],
});

describe('matchCedict', () => {
  const xing = [
    entry('行', '行', 'hang2', 'row'),
    entry('行', '行', 'xing2', 'to walk'),
  ];

  it('picks the reading that matches the syllabus pinyin', () => {
    expect(matchCedict('háng', xing).entries[0]!.pinyin).toBe('hang2');
    expect(matchCedict('xíng', xing).entries[0]!.pinyin).toBe('xing2');
  });

  it('matches through tone differences such as 一/不 sandhi', () => {
    const result = matchCedict('bú kèqi', [
      entry('不客氣', '不客气', 'bu4 ke4 qi5'),
    ]);
    expect(result.match).toBe('tones-differ');
  });

  it('prefers ordinary entries over surnames', () => {
    const result = matchCedict('gān', [
      entry('甘', '甘', 'Gan1', 'surname Gan'),
      entry('甘', '甘', 'gan1', 'sweet', 'willing'),
    ]);
    expect(result.entries[0]!.definitions).toEqual(['sweet', 'willing']);
  });

  it('reports no match when the syllables differ', () => {
    expect(matchCedict('chī', xing)).toEqual({ match: 'none', entries: [] });
  });
});

describe('citationFromSyllabus', () => {
  it.each([
    ['xuéshēng', 'xue2 sheng5', '学生', 'xue2 sheng1'],
    ['bú kèqi', 'bu4 ke4 qi5', '不客气', 'bu4 ke4 qi5'],
    ['duìbuqǐ', 'dui4 bu4 qi3', '对不起', 'dui4 bu5 qi3'],
    ['yíxià', 'yi1 xia4', '一下', 'yi1 xia4'],
    ['yìdiǎnr', 'yi1 dian3 r5', '一点儿', 'yi1 dian3 r5'],
    ['nǚ’ér', 'nu:3 er2', '女儿', 'nü3 er2'],
    [
      'Zhōnghuá Mínzú',
      'Zhong1 hua2 Min2 zu2',
      '中华民族',
      'zhong1 hua2 min2 zu2',
    ],
  ])('%s → %s', (syllabus, cedict, word, expected) => {
    expect(citationFromSyllabus(syllabus, cedict, word)).toBe(expected);
  });

  it('returns null when the syllables do not line up', () => {
    expect(citationFromSyllabus('xíng', 'hang2', '行')).toBeNull();
  });
});

describe('composeFromParts', () => {
  it('splits a missing word into dictionary words that fit the pinyin', () => {
    const dict = new Map([
      ['口哨', [entry('口哨', '口哨', 'kou3 shao4')]],
      ['儿', [entry('兒', '儿', 'er2'), entry('兒', '儿', 'r5')]],
    ]);
    const parts = composeFromParts('口哨儿', 'kǒushàor', dict);
    expect(parts?.map((p) => p.pinyin)).toEqual(['kou3 shao4', 'r5']);
  });

  it('returns null when no split fits', () => {
    expect(composeFromParts('口哨儿', 'kǒushàor', new Map())).toBeNull();
  });
});
