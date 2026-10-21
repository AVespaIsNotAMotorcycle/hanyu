import { describe, expect, it } from 'vitest';
import { audioKeys, listeningClips } from './audio.js';
import { countSentences, type ListeningExercise } from './listening.js';

describe('countSentences', () => {
  it('counts runs ending in sentence marks, and a final one without', () => {
    expect(countSentences('我叫小明。')).toBe(1);
    expect(countSentences('你好！我是老师。你呢？')).toBe(3);
    expect(countSentences('今天很冷，我不想出去')).toBe(1);
    expect(countSentences('他说：“好！”我们走吧。')).toBe(2);
    expect(countSentences('')).toBe(0);
  });
});

describe('listeningClips', () => {
  it('covers the text and each question prompt', () => {
    const exercise = {
      _id: 'l1-0001',
      text: '我明天去北京。',
      questions: [
        { id: 'c1', type: 'choice', prompt: '他明天去哪儿？' },
        { id: 'c2', type: 'choice', prompt: '他什么时候去？' },
      ],
    } as unknown as ListeningExercise;
    expect(listeningClips(exercise)).toEqual([
      { key: 'listening:l1-0001', text: '我明天去北京。', pinyin: null },
      {
        key: audioKeys.listeningPrompt('l1-0001', 'c1'),
        text: '他明天去哪儿？',
        pinyin: null,
      },
      {
        key: 'listening:l1-0001:q:c2',
        text: '他什么时候去？',
        pinyin: null,
      },
    ]);
  });
});
