import { describe, expect, it } from 'vitest';
import { checkLevel, tokenize } from '../src/passages/level.js';
import { loadSeedContent } from '../src/passages/content.js';
import { createSegmenter } from '../src/segmenter.js';

const content = loadSeedContent();
const segmenter = createSegmenter(content.wordLevels.keys());
const check = (text: string, level: 1 | 2 | 3, names: string[] = []) =>
  checkLevel(text, level, { segmenter, wordLevels: content.wordLevels, names });

describe('checkLevel (with the real HSK lists and jieba)', () => {
  it('passes a passage made of HSK 1 words', () => {
    const result = check(
      '我是学生。我喜欢喝茶，也喜欢看书。今天我和朋友去学校。',
      1,
    );
    expect(result.offLevel).toEqual([]);
    expect(result.share).toBe(1);
    expect(result.tokens).toBeGreaterThan(10);
  });

  it('lists words above the level', () => {
    // 咖啡 is HSK 2; 博物馆 is above HSK 3.
    const result = check('我喝咖啡。我们去博物馆。', 1);
    expect(result.offLevel).toEqual(expect.arrayContaining(['咖啡', '博物馆']));
    expect(result.share).toBeLessThan(1);
    expect(check('我喝咖啡。', 2).offLevel).toEqual([]);
  });

  it('splits compounds jieba makes out of known words', () => {
    // jieba keeps 喝咖啡 whole: 喝 is HSK 1 and 咖啡 HSK 2.
    expect(segmenter.segment('我喝咖啡。')).toContain('喝咖啡');
    expect(check('我喝咖啡。', 2).offLevel).toEqual([]);
    // At HSK 1, only the unknown part is reported.
    expect(check('我喝咖啡。', 1).offLevel).toEqual(['咖啡']);
  });

  it('counts declared names as known and ignores punctuation and digits', () => {
    const result = check('小明有3本书。', 1, ['小明']);
    expect(result.offLevel).toEqual([]);
    expect(check('欧阳有书。', 1).offLevel).toContain('欧阳');
  });
});

describe('tokenize', () => {
  const tokens = (text: string, names: string[] = []) =>
    tokenize(text, { segmenter, wordLevels: content.wordLevels, names });

  it('splits paragraphs into words that join back into the text', () => {
    const text = '小明喝咖啡。他有3本书。\n\n我们去 学校。';
    const result = tokens(text, ['小明']);
    expect(result.map((p) => p.join(''))).toEqual([
      '小明喝咖啡。他有3本书。',
      '我们去 学校。',
    ]);
    // jieba's 喝咖啡 and 本书 are split into HSK words; the name stays whole.
    expect(result[0]).toEqual(
      expect.arrayContaining(['小明', '喝', '咖啡', '本', '书']),
    );
    expect(result[0]).not.toContain('喝咖啡');
  });

  it('keeps unknown runs as tokens of their own', () => {
    expect(tokens('欧阳去学校。')[0]!.join('|')).toMatch(
      /欧阳.*\|去\|学校\|。/,
    );
  });
});
