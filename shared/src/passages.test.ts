import { describe, expect, it } from 'vitest';
import { cardKey, type GrammarPoint } from './content.js';
import {
  checkClozeAnswer,
  grammarIndex,
  knownShare,
  normalizeHanziAnswer,
  paragraphs,
  passageCompletion,
  passageFamiliarity,
  recommendPassages,
  type PassageSummary,
} from './passages.js';
import { summarizeCards } from './queue.js';

describe('passageCompletion', () => {
  const passage = {
    questionCount: 6,
    translationCount: 4,
    progress: { answered: 0, correct: 0, translated: 0 },
  };
  const at = (answered: number, translated: number) =>
    passageCompletion({
      ...passage,
      progress: { answered, correct: 0, translated },
    });

  it('counts questions and translated paragraphs alike', () => {
    expect(at(0, 0)).toBe(0);
    expect(at(6, 0)).toBe(60);
    expect(at(6, 2)).toBe(80);
    expect(at(6, 4)).toBe(100);
  });

  it('only says 100 when everything is done', () => {
    expect(
      passageCompletion({
        questionCount: 200,
        translationCount: 1,
        progress: { answered: 200, correct: 0, translated: 0 },
      }),
    ).toBe(99);
  });

  it('counts a passage without translations by its questions', () => {
    expect(
      passageCompletion({
        questionCount: 2,
        translationCount: 0,
        progress: { answered: 1, correct: 0, translated: 0 },
      }),
    ).toBe(50);
  });
});

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
    translationCount: 0,
    vocabulary,
  });

  describe('grammarIndex', () => {
    const point = (id: string, level: 1 | 2, order: number) =>
      ({
        _id: id,
        level,
        order,
        category: '',
        name: '',
        item: '',
        content: '',
        title: id,
        explanation: '',
      }) satisfies GrammarPoint;
    const word = (wordId: string, count: number) => ({
      text: wordId,
      wordIds: [wordId],
      count,
    });
    const using = (
      id: string,
      grammarIds: string[],
      vocabulary: PassageSummary['vocabulary'],
    ) => ({ ...summary(id, 1, vocabulary), grammarIds });

    const half = using(
      'half',
      ['a', 'b'],
      [word('w-known', 1), word('w-new', 1)],
    );
    const most = using('most', ['b'], [word('w-known', 3), word('w-new', 1)]);
    const none = using('none', ['c', 'd'], [word('w-new', 1)]);
    const passages = [half, most, none];

    it('ranks a point by its best passage, listing that passage first', () => {
      const entries = grammarIndex(
        [
          point('a', 1, 1),
          point('b', 1, 2),
          point('c', 1, 3),
          point('unused', 1, 4),
        ],
        passages,
        summaries,
      );
      expect(entries.map((e) => e.point._id)).toEqual(['b', 'a', 'c']);
      expect(entries[0]!.passages.map((p) => p._id)).toEqual(['most', 'half']);
      expect(entries.map((e) => e.bestKnown)).toEqual([0.75, 0.5, 0]);
    });

    it('counts learning words as not known', () => {
      const learning = using('l', ['a'], [word('w-learning', 1)]);
      expect(
        grammarIndex([point('a', 1, 1)], [learning], summaries)[0]!.bestKnown,
      ).toBe(0);
      expect(knownShare({ known: 0, learning: 0, total: 0, score: 0 })).toBe(0);
    });

    it('breaks ties by level, then syllabus order', () => {
      const entries = grammarIndex(
        [point('d', 2, 1), point('c', 1, 9)],
        passages,
        summaries,
      );
      expect(entries.map((e) => e.point._id)).toEqual(['c', 'd']);
    });
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
