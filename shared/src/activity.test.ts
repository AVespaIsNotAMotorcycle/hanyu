import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildActivity,
  computeStreaks,
  MAX_COUNTED_CARD_MS,
} from './activity.js';
import { cardKey, type Rating } from './content.js';
import { studyDayKey } from './queue.js';

const card = (id: string) => cardKey('word', id, 'pinyin');
const review = (
  id: string,
  reviewedAt: string,
  rating: Rating = 3,
  durationMs?: number,
) => ({ cardKey: card(id), reviewedAt, rating, durationMs });

describe('studyDayKey', () => {
  it('counts the hours before 4 a.m. as the day before', () => {
    expect(studyDayKey(new Date('2026-03-10T03:59:00Z'), 'UTC')).toBe(
      '2026-03-09',
    );
    expect(studyDayKey(new Date('2026-03-10T04:00:00Z'), 'UTC')).toBe(
      '2026-03-10',
    );
  });

  it('uses the local date', () => {
    // 11 p.m. on the 9th in New York.
    const at = new Date('2026-03-10T03:00:00Z');
    expect(studyDayKey(at, 'America/New_York')).toBe('2026-03-09');
    // Noon on the 10th in Shanghai.
    expect(studyDayKey(new Date('2026-03-10T04:00:00Z'), 'Asia/Shanghai')).toBe(
      '2026-03-10',
    );
  });
});

describe('buildActivity', () => {
  it('counts answers, new cards, and reviewed cards by day', () => {
    const days = buildActivity({
      timeZone: 'UTC',
      reviews: [
        review('a', '2026-03-09T12:00:00Z', 3, 5000),
        // A repeat on the first day is neither new nor a review.
        review('a', '2026-03-09T12:10:00Z', 1, 5000),
        review('b', '2026-03-09T12:20:00Z'),
        // Twice the next day, but one card reviewed.
        review('a', '2026-03-10T12:00:00Z', 1),
        review('a', '2026-03-10T12:10:00Z', 3),
        review('c', '2026-03-10T12:20:00Z'),
      ],
    });
    expect(days.map((d) => d.day)).toEqual(['2026-03-09', '2026-03-10']);
    expect(days[0]).toMatchObject({
      answers: 3,
      correct: 2,
      newCards: 2,
      reviewedCards: 0,
      durationMs: 10000,
    });
    expect(days[1]).toMatchObject({
      answers: 3,
      correct: 2,
      newCards: 1,
      reviewedCards: 1,
    });
  });

  it('finds first reviews whatever order the logs arrive in', () => {
    const days = buildActivity({
      timeZone: 'UTC',
      reviews: [
        review('a', '2026-03-10T12:00:00Z'),
        review('a', '2026-03-09T12:00:00Z'),
      ],
    });
    expect(days[0]!.newCards).toBe(1);
    expect(days[1]).toMatchObject({ newCards: 0, reviewedCards: 1 });
  });

  it('caps the time a card counts for', () => {
    const [day] = buildActivity({
      timeZone: 'UTC',
      reviews: [review('a', '2026-03-09T12:00:00Z', 3, 60 * 60 * 1000)],
    });
    expect(day!.durationMs).toBe(MAX_COUNTED_CARD_MS);
  });

  it('counts an exercise once all its questions are answered in a day', () => {
    const at = '2026-03-09T12:00:00Z';
    const answer = (exerciseId: string, questionId: string) => ({
      exerciseId,
      questionId,
      correct: true,
      at,
    });
    const [day] = buildActivity({
      timeZone: 'UTC',
      reviews: [],
      answers: [
        // Retrying a question doesn't finish the passage…
        answer('p1-0001', 'q1'),
        answer('p1-0001', 'q1'),
        // …answering the rest does, once.
        answer('p1-0002', 'q1'),
        answer('p1-0002', 'q2'),
        answer('p1-0002', 'q2'),
        answer('l1-0001', 'c1'),
        // Not in questionCounts (deleted): the question still counts.
        answer('l1-0002', 'c1'),
      ],
      questionCounts: { 'p1-0001': 2, 'p1-0002': 2, 'l1-0001': 1 },
    });
    expect(day).toMatchObject({
      readingQuestions: 5,
      readingExercises: 1,
      listeningQuestions: 2,
      listeningExercises: 1,
    });
  });

  it('does not finish an exercise across days', () => {
    const answer = (questionId: string, at: string) => ({
      exerciseId: 'p1-0001',
      questionId,
      correct: true,
      at,
    });
    const days = buildActivity({
      timeZone: 'UTC',
      reviews: [],
      answers: [
        answer('q1', '2026-03-09T12:00:00Z'),
        answer('q2', '2026-03-10T12:00:00Z'),
      ],
      questionCounts: { 'p1-0001': 2 },
    });
    expect(days.map((d) => d.readingExercises)).toEqual([0, 0]);
  });

  it('counts translations', () => {
    const [day] = buildActivity({
      timeZone: 'UTC',
      reviews: [],
      translations: ['2026-03-09T12:00:00Z'],
    });
    expect(day!.translations).toBe(1);
  });
});

describe('addDays', () => {
  it('crosses months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('computeStreaks', () => {
  const days = (...list: string[]) => list.map((day) => ({ day }));

  it('counts back from today', () => {
    expect(
      computeStreaks(
        days('2026-03-01', '2026-03-08', '2026-03-09', '2026-03-10'),
        '2026-03-10',
      ),
    ).toEqual({
      current: 3,
      longest: 3,
      activeDays: 4,
      activeToday: true,
    });
  });

  it('stays alive until a whole day is missed', () => {
    const history = days('2026-03-08', '2026-03-09');
    expect(computeStreaks(history, '2026-03-10')).toMatchObject({
      current: 2,
      activeToday: false,
    });
    expect(computeStreaks(history, '2026-03-11').current).toBe(0);
  });

  it('remembers the longest run', () => {
    expect(
      computeStreaks(
        days('2026-01-01', '2026-01-02', '2026-01-03', '2026-03-10'),
        '2026-03-10',
      ),
    ).toMatchObject({ current: 1, longest: 3 });
  });

  it('handles no history', () => {
    expect(computeStreaks([], '2026-03-10')).toEqual({
      current: 0,
      longest: 0,
      activeDays: 0,
      activeToday: false,
    });
  });
});
