import { describe, expect, it } from 'vitest';
import { createSegmenter, isHanziToken } from '../src/segmenter.js';

describe('createSegmenter', () => {
  it('segments Chinese text into words', () => {
    const tokens = createSegmenter().segment('我是大学生，我在北京学习汉语。');
    expect(tokens.filter(isHanziToken)).toEqual([
      '我',
      '是',
      '大学生',
      '我',
      '在',
      '北京',
      '学习',
      '汉语',
    ]);
  });

  it('keeps added words whole', () => {
    expect(createSegmenter().segment('正能量')).toEqual(['正', '能量']);
    expect(createSegmenter(['正能量']).segment('正能量')).toEqual(['正能量']);
  });
});
