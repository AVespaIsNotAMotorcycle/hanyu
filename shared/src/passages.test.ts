import { describe, expect, it } from 'vitest';
import {
  checkClozeAnswer,
  normalizeHanziAnswer,
  paragraphs,
} from './passages.js';

describe('checkClozeAnswer', () => {
  const question = { answer: '喜欢', alsoAccepted: ['爱'] };

  it('accepts the answer and alternatives, ignoring spaces and punctuation', () => {
    for (const typed of ['喜欢', ' 喜欢 ', '喜欢。', '爱', '喜 欢！']) {
      expect(checkClozeAnswer(typed, question), typed).toBe(true);
    }
  });

  it('rejects anything else, including nothing', () => {
    for (const typed of ['', '  ', '喜', '喜欢吃', 'xihuan']) {
      expect(checkClozeAnswer(typed, question), typed).toBe(false);
    }
  });

  it('treats full-width and half-width forms alike', () => {
    expect(normalizeHanziAnswer('ＡＢ１')).toBe('AB1');
    expect(checkClozeAnswer('３', { answer: '3', alsoAccepted: [] })).toBe(
      true,
    );
  });
});

describe('paragraphs', () => {
  it('splits on blank lines and trims', () => {
    expect(paragraphs('我是学生。\n\n  他是老师。 \n\n\n')).toEqual([
      '我是学生。',
      '他是老师。',
    ]);
  });
});
