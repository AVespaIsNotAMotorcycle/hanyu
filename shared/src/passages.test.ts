import { describe, expect, it } from 'vitest';
import { cardKey } from './content.js';
import {
  checkClozeAnswer,
  normalizeHanziAnswer,
  paragraphs,
  passageFamiliarity,
  recommendPassages,
  type PassageSummary,
} from './passages.js';
import { summarizeCards } from './queue.js';

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

describe('passageFamiliarity and recommendPassages', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;
  let n = 0;
  /** Logs that leave a word in review (two Good answers a day apart) or learning. */
  const logs = (wordId: string, phase: 'review' | 'learning') =>
    (phase === 'review'
      ? [now.getTime() - 3 * DAY, now.getTime() - DAY]
      : [now.getTime()]
    ).map((t) => ({
      _id: `l${n++}`,
      cardKey: cardKey('word', wordId, 'pinyin'),
      rating: 3 as const,
      reviewedAt: new Date(t),
    }));
  const summaries = summarizeCards([
    ...logs('w-known', 'review'),
    ...logs('w-learning', 'learning'),
    ...logs('w-hang', 'review'),
  ]);

  const summary = (
    id: string,
    level: 1 | 2,
    vocabulary: PassageSummary['vocabulary'],
  ): PassageSummary => ({
    _id: id,
    level,
    title: id,
    titleEnglish: id,
    length: 10,
    grammarIds: [],
    questionCount: 0,
    translatable: false,
    vocabulary,
  });

  it('weights known and learning words by occurrence', () => {
    expect(summaries.get('word:w-known:pinyin')!.schedule.phase).toBe('review');
    expect(summaries.get('word:w-learning:pinyin')!.schedule.phase).toBe(
      'learning',
    );
    const familiarity = passageFamiliarity(
      [
        { text: '我', wordIds: ['w-known'], count: 3 },
        { text: '学', wordIds: ['w-learning'], count: 2 },
        // A homograph counts if any of its readings is known.
        { text: '行', wordIds: ['w-xing', 'w-hang'], count: 1 },
        { text: '博物馆', wordIds: [], count: 2 },
      ],
      summaries,
    );
    expect(familiarity).toEqual({
      known: 4,
      learning: 2,
      total: 8,
      score: 5 / 8,
    });
    expect(passageFamiliarity([], summaries).score).toBe(0);
  });

  it('recommends unread passages, most familiar first, then lower levels', () => {
    const known = [{ text: '我', wordIds: ['w-known'], count: 1 }];
    const unknown = [{ text: '你', wordIds: ['w-new'], count: 1 }];
    const passages = [
      summary('p2-0001', 2, known),
      summary('p1-0002', 1, unknown),
      summary('p1-0001', 1, known),
      summary('p1-0003', 1, known),
    ];
    const ids = (read: string[], limit?: number) =>
      recommendPassages(passages, summaries, new Set(read), limit).map(
        (r) => r.passage._id,
      );
    expect(ids([])).toEqual(['p1-0001', 'p1-0003', 'p2-0001']);
    expect(ids(['p1-0001'], 4)).toEqual(['p1-0003', 'p2-0001', 'p1-0002']);
    // Everything read: start over.
    expect(
      ids(
        passages.map((p) => p._id),
        1,
      ),
    ).toEqual(['p1-0001']);
  });
});
