import { describe, expect, it } from 'vitest';
import { cedictHeader, parseCedict } from '../src/parse/cedict.js';
import { parseCsv } from '../src/parse/csv.js';
import { parseGrammar } from '../src/parse/grammar.js';
import { parseHskWords, parseLevel } from '../src/parse/hsk.js';

describe('parseCsv', () => {
  it('handles a BOM, quoted fields, escaped quotes, and CRLF', () => {
    const csv = '﻿a,b\r\n1,"x, ""y"""\r\n2,z\r\n';
    expect(parseCsv(csv)).toEqual([
      { a: '1', b: 'x, "y"' },
      { a: '2', b: 'z' },
    ]);
  });
});

describe('parseLevel', () => {
  it.each([
    ['1', 1],
    ['6', 6],
    ['7-9', 7],
    ['1-2', 2],
  ])('%s → %i', (label, level) => {
    expect(parseLevel(label)).toBe(level);
  });

  it('rejects unknown labels', () => {
    expect(() => parseLevel('10')).toThrow();
  });
});

describe('parseHskWords', () => {
  it('reads levels, homographs, and parts of speech', () => {
    const csv = [
      'id,level,hanzi,pinyin,part_of_speech,entry,homograph,level_label,source_pdf_page',
      '7,1,半,bàn,数、（副）,半,,1（4）,80',
      '10,1,本,běn,量,本1,1,1,80',
      '14,1,不客气,bú kèqi,,不客气,,1,80',
    ].join('\n');
    expect(parseHskWords(csv)).toEqual([
      {
        hskId: 7,
        level: 1,
        levelLabel: '1（4）',
        simplified: '半',
        homograph: null,
        pinyin: 'bàn',
        partsOfSpeech: ['数', '副'],
      },
      {
        hskId: 10,
        level: 1,
        levelLabel: '1',
        simplified: '本',
        homograph: 1,
        pinyin: 'běn',
        partsOfSpeech: ['量'],
      },
      {
        hskId: 14,
        level: 1,
        levelLabel: '1',
        simplified: '不客气',
        homograph: null,
        pinyin: 'bú kèqi',
        partsOfSpeech: [],
      },
    ]);
  });
});

describe('parseGrammar', () => {
  it('assigns IDs and cleans stray spaces', () => {
    const json = JSON.stringify([
      {
        类别: '词类',
        类别名称: '助词',
        细目: '语气助词',
        语法内容: '吧1、了2 、吗',
      },
    ]);
    expect(parseGrammar(json, 1)).toEqual([
      {
        _id: 'g1-001',
        level: 1,
        order: 1,
        category: '词类',
        name: '助词',
        item: '语气助词',
        content: '吧1、了2、吗',
      },
    ]);
  });
});

describe('parseCedict', () => {
  const text = [
    '# CC-CEDICT',
    '#! date=2026-10-14T21:50:50Z',
    '行 行 [hang2] /row; line/classifier for rows or lines/',
    '行 行 [xing2] /to walk/capable/',
    '學生 学生 [xue2 sheng5] /student/schoolchild/',
  ].join('\r\n');

  it('groups entries by simplified form', () => {
    const dict = parseCedict(text);
    expect(dict.get('行')?.map((e) => e.pinyin)).toEqual(['hang2', 'xing2']);
    expect(dict.get('学生')).toEqual([
      {
        traditional: '學生',
        simplified: '学生',
        pinyin: 'xue2 sheng5',
        definitions: ['student', 'schoolchild'],
      },
    ]);
  });

  it('reads header fields', () => {
    expect(cedictHeader(text).date).toBe('2026-10-14T21:50:50Z');
  });
});
