import { describe, expect, it } from 'vitest';
import type { ActivityAnswer } from './activity.js';
import { cardKey, type Rating, type WordNote } from './content.js';
import type { CharacterContent } from './dataset.js';
import { summarizeCards } from './queue.js';
import {
  buildReadiness,
  cardRecall,
  firstTryShares,
  RECALL_REVIEWS,
  type ReadinessInput,
} from './readiness.js';

const now = new Date('2026-03-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) =>
  new Date(now.getTime() - days * DAY).toISOString();

describe('cardRecall', () => {
  const review = (rating: Rating, days: number) => ({
    cardKey: 'word:a:pinyin',
    rating,
    reviewedAt: ago(days),
  });

  it('gives full marks for Good and Easy, half for Hard, none for Again', () => {
    const recall = cardRecall([review(3, 3), review(2, 2), review(1, 1)]);
    expect(recall.get('word:a:pinyin')).toBeCloseTo(0.5);
    expect(cardRecall([review(4, 1)]).get('word:a:pinyin')).toBe(1);
  });

  it('judges only the latest answers, so a missed card can recover', () => {
    const misses = Array.from({ length: 5 }, (_, i) => review(1, 20 + i));
    const rights = Array.from({ length: RECALL_REVIEWS }, (_, i) =>
      review(3, i),
    );
    // Out of order, as logs from several devices can be.
    expect(cardRecall([...rights, ...misses]).get('word:a:pinyin')).toBe(1);
  });
});

const answer = (
  exerciseId: string,
  questionId: string,
  correct: boolean,
  days = 1,
): ActivityAnswer => ({ exerciseId, questionId, correct, at: ago(days) });

describe('firstTryShares', () => {
  it('counts only the first try at each question', () => {
    const shares = firstTryShares(
      [
        answer('p1-0001', 'q1', false, 2),
        answer('p1-0001', 'q1', true, 1),
        answer('p1-0001', 'q2', true, 1),
      ],
      { 'p1-0001': 2 },
      now,
    );
    expect(shares.get('reading:1')).toBe(0.5);
  });

  it('keeps skills and levels apart', () => {
    const shares = firstTryShares(
      [
        answer('p1-0001', 'q1', true),
        answer('p2-0001', 'q1', false),
        answer('l1-0001', 'c1', false),
      ],
      { 'p1-0001': 1, 'p2-0001': 1, 'l1-0001': 1 },
      now,
    );
    expect(shares.get('reading:1')).toBe(1);
    expect(shares.get('reading:2')).toBe(0);
    expect(shares.get('listening:1')).toBe(0);
  });

  it('ignores unfinished exercises', () => {
    const shares = firstTryShares(
      [answer('p1-0001', 'q1', true)],
      { 'p1-0001': 2 },
      now,
    );
    expect(shares.has('reading:1')).toBe(false);
  });

  it('ignores anything older than a week, and restarts first tries', () => {
    const shares = firstTryShares(
      [
        answer('p1-0001', 'q1', false, 8),
        answer('p1-0002', 'q1', true, 8),
        answer('p1-0001', 'q1', true, 1),
      ],
      { 'p1-0001': 1, 'p1-0002': 1 },
      now,
    );
    expect(shares.get('reading:1')).toBe(1);
  });
});

describe('buildReadiness', () => {
  // HSK 1 here has two words and two characters: four cards.
  const words = new Map(
    ['a', 'b'].map((id) => [id, { _id: id, level: 1 } as WordNote]),
  );
  const characters = new Map(
    ['甲', '乙'].map((id) => [
      id,
      { _id: id, introLevel: 1 } as CharacterContent,
    ]),
  );
  const keys = [
    cardKey('word', 'a', 'pinyin'),
    cardKey('word', 'b', 'pinyin'),
    cardKey('character', '甲', 'handwriting'),
    cardKey('character', '乙', 'handwriting'),
  ];
  const logs = (cards: string[], rating: Rating = 3) =>
    cards.map((key) => ({
      _id: key,
      cardKey: key,
      rating,
      reviewedAt: new Date(ago(2)),
    }));
  const finished = (correct: boolean[], prefix: 'p1' | 'l1') =>
    correct.map((right, i) => answer(`${prefix}-0001`, `q${i}`, right));

  const level1 = (
    reviews: ReturnType<typeof logs>,
    answers: ActivityAnswer[] = [],
    questionCounts: ReadinessInput['questionCounts'] = {
      'p1-0001': 10,
      'l1-0001': 10,
    },
  ) =>
    buildReadiness({
      summaries: summarizeCards(reviews),
      words,
      characters,
      dataset: {
        levelCounts: { 1: 2 } as never,
        characterLevelCounts: { 1: 2 } as never,
      },
      recall: cardRecall(reviews),
      answers,
      questionCounts,
      now,
    })[0]!;

  const nineOfTen = [...Array(9).fill(true), false] as boolean[];

  it('is 100 with every card perfect and 90% first tries on both skills', () => {
    const result = level1(logs(keys), [
      ...finished(nineOfTen, 'p1'),
      ...finished(nineOfTen, 'l1'),
    ]);
    expect(result.score).toBe(100);
    expect(result).toMatchObject({ reading: 0.9, listening: 0.9, recall: 1 });
  });

  it('caps at 60 with no recent exercises', () => {
    expect(level1(logs(keys)).score).toBe(60);
  });

  it('cannot reach 100 without both reading and listening', () => {
    const perfect = Array(10).fill(true) as boolean[];
    expect(level1(logs(keys), finished(perfect, 'p1')).score).toBe(80);
    expect(level1(logs(keys), finished(perfect, 'l1')).score).toBe(80);
  });

  it('cannot reach 100 without handwriting', () => {
    const result = level1(logs(keys.slice(0, 2)), [
      ...finished(nineOfTen, 'p1'),
      ...finished(nineOfTen, 'l1'),
    ]);
    expect(result.started).toBe(0.5);
    expect(result.score).toBe(70);
  });

  it('counts words not yet started as not known', () => {
    // One perfect card of four is a quarter of the vocabulary part.
    expect(level1(logs(keys.slice(0, 1))).score).toBe(15);
  });

  it('lowers the score for poor recall', () => {
    expect(level1(logs(keys, 2)).score).toBe(30);
  });

  it('scales first tries toward the target', () => {
    const half = [...Array(9).fill(true), false].map((_, i) => i < 45 / 10);
    const result = level1(logs(keys), finished(half, 'p1'));
    expect(result.reading).toBe(0.5);
    // 0.5 of the 0.9 target earns 5/9 of the reading part.
    expect(result.score).toBe(71);
  });

  it('is 0 with nothing done', () => {
    expect(level1([])).toMatchObject({
      score: 0,
      started: 0,
      recall: null,
      reading: null,
      listening: null,
    });
  });
});
