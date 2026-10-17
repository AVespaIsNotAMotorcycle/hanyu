import { describe, expect, it } from 'vitest';
import { audioKeys, passageClips, sapiPinyin, wordClips } from './audio.js';
import type { WordNote } from './content.js';
import type { Passage } from './passages.js';

describe('sapiPinyin', () => {
  it('writes pinyin the way Azure’s zh-CN phone set does', () => {
    expect(sapiPinyin('ni3 hao3')).toBe('ni 3 hao 3');
    expect(sapiPinyin('nü3 er2')).toBe('nv 3 er 2');
    expect(sapiPinyin('lu:4')).toBe('lv 4');
    expect(sapiPinyin('yi2 huir4')).toBe('yi 2 hui r 4');
    expect(sapiPinyin('peng2 you5')).toBe('peng 2 you 5');
    expect(sapiPinyin('na3 r5')).toBe('na r 3');
    expect(sapiPinyin('r5')).toBeNull();
    expect(sapiPinyin('hang')).toBeNull();
  });
});

const word = (id: string, simplified: string, citationPinyin: string) =>
  ({ _id: id, simplified, citationPinyin }) as WordNote;

describe('wordClips', () => {
  it('forces the reading only where a word is read more than one way', () => {
    const clips = wordClips([
      word('w1', '行', 'xing2'),
      word('w2', '行', 'hang2'),
      word('w3', '本', 'ben3'),
      word('w4', '本', 'ben3'),
      word('w5', '学生', 'xue2 sheng5'),
    ]);
    expect(clips.map((c) => [c.key, c.pinyin])).toEqual([
      ['word:w1', 'xing2'],
      ['word:w2', 'hang2'],
      ['word:w3', null],
      ['word:w4', null],
      ['word:w5', null],
    ]);
  });
});

describe('passageClips', () => {
  it('covers the title, paragraphs, and question sentences', () => {
    const passage = {
      _id: 'p1-0001',
      title: '我的家',
      text: '我有一个家。\n\n家里有三个人。',
      questions: [
        {
          id: 'q1',
          type: 'choice',
          prompt: '家里有几个人？',
          promptEnglish: '',
          options: [],
          answer: 0,
          explanation: '',
        },
        {
          id: 'q2',
          type: 'cloze',
          sentence: '我有一个＿＿。',
          answer: '家',
          alsoAccepted: [],
          hint: '',
        },
      ],
    } as unknown as Passage;
    expect(passageClips(passage).map((c) => [c.key, c.text])).toEqual([
      [audioKeys.passageTitle('p1-0001'), '我的家'],
      ['passage:p1-0001:p0', '我有一个家。'],
      ['passage:p1-0001:p1', '家里有三个人。'],
      ['passage:p1-0001:q:q1', '家里有几个人？'],
      ['passage:p1-0001:c:q2', '我有一个家。'],
    ]);
  });
});
