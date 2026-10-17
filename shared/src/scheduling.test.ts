import { describe, expect, it } from 'vitest';
import type { Rating } from './content.js';
import {
  applyReview,
  isDue,
  newCardSchedule,
  previewDue,
  replayByCard,
  replayReviews,
  retrievability,
  type ReviewEvent,
} from './scheduling.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const start = new Date('2026-10-01T09:00:00Z');

/** Reviews at the given offsets from `start`, with sequential IDs. */
function reviews(...entries: [offsetMs: number, rating: Rating][]) {
  return entries.map(([offset, rating], i): ReviewEvent => ({
    _id: `r${i}`,
    rating,
    reviewedAt: new Date(start.getTime() + offset),
  }));
}

describe('replayReviews', () => {
  it('returns a new card when there are no reviews', () => {
    const schedule = replayReviews([]);
    expect(schedule.phase).toBe('new');
    expect(schedule.reps).toBe(0);
    expect(isDue(schedule)).toBe(false);
  });

  it('moves a new card through learning steps into review', () => {
    const learning = replayReviews(reviews([0, 3]));
    expect(learning.phase).toBe('learning');
    expect(learning.due.getTime() - start.getTime()).toBe(10 * MINUTE);

    const graduated = replayReviews(reviews([0, 3], [10 * MINUTE, 3]));
    expect(graduated.phase).toBe('review');
    expect(graduated.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(graduated.reps).toBe(2);
  });

  it('sends a forgotten review card to relearning and counts the lapse', () => {
    const graduated = replayReviews(reviews([0, 3], [10 * MINUTE, 3]));
    const lapsed = applyReview(graduated, {
      rating: 1,
      reviewedAt: graduated.due,
    });
    expect(lapsed.phase).toBe('relearning');
    expect(lapsed.lapses).toBe(1);
  });

  it('schedules Easy further out than Good, and Good than Hard', () => {
    const base = replayReviews(reviews([0, 3], [10 * MINUTE, 3]));
    const preview = previewDue(base, base.due);
    expect(preview[4].getTime()).toBeGreaterThan(preview[3].getTime());
    expect(preview[3].getTime()).toBeGreaterThan(preview[2].getTime());
    expect(preview[2].getTime()).toBeGreaterThan(preview[1].getTime());
  });

  it('gives the same state regardless of log order (sync is a union)', () => {
    const history = reviews(
      [0, 3],
      [10 * MINUTE, 3],
      [3 * DAY, 2],
      [9 * DAY, 1],
      [9 * DAY + 10 * MINUTE, 3],
      [20 * DAY, 4],
    );
    const inOrder = replayReviews(history);
    const shuffled = replayReviews([...history].reverse());
    // As the client would get them back from JSON or IndexedDB.
    const fromJson = replayReviews(JSON.parse(JSON.stringify(history)));
    expect(shuffled).toEqual(inOrder);
    expect(fromJson).toEqual(inOrder);
  });

  it('is deterministic despite fuzzed intervals', () => {
    const history = reviews([0, 3], [10 * MINUTE, 3], [4 * DAY, 3]);
    expect(replayReviews(history)).toEqual(replayReviews(history));
  });

  it('breaks ties between simultaneous reviews by ID', () => {
    const tied: ReviewEvent[] = [
      { _id: 'b', rating: 1, reviewedAt: start },
      { _id: 'a', rating: 4, reviewedAt: start },
    ];
    expect(replayReviews(tied)).toEqual(replayReviews([...tied].reverse()));
    // 'a' (Easy) first, then 'b' (Again).
    expect(replayReviews(tied)).toEqual(
      applyReview(applyReview(newCardSchedule(start), tied[1]!), tied[0]!),
    );
  });

  it('rejects invalid ratings and times', () => {
    expect(() =>
      replayReviews([{ _id: 'x', rating: 0 as Rating, reviewedAt: start }]),
    ).toThrow(/rating/);
    expect(() =>
      replayReviews([{ _id: 'x', rating: 3, reviewedAt: 'not a date' }]),
    ).toThrow(/review time/);
  });
});

describe('replayByCard', () => {
  it('groups a mixed log stream by card key', () => {
    const [a1, a2, b1] = reviews([0, 3], [10 * MINUTE, 3], [5 * MINUTE, 1]);
    const schedules = replayByCard([
      { ...b1!, cardKey: 'word:hsk30-00002:pinyin' },
      { ...a2!, cardKey: 'word:hsk30-00001:pinyin' },
      { ...a1!, cardKey: 'word:hsk30-00001:pinyin' },
    ]);
    expect(schedules.get('word:hsk30-00001:pinyin')).toEqual(
      replayReviews([a1!, a2!]),
    );
    expect(schedules.get('word:hsk30-00002:pinyin')!.reps).toBe(1);
  });
});

describe('isDue and retrievability', () => {
  it('reports due cards and decaying recall', () => {
    const schedule = replayReviews(reviews([0, 3], [10 * MINUTE, 3]));
    const before = new Date(schedule.due.getTime() - MINUTE);
    expect(isDue(schedule, before)).toBe(false);
    expect(isDue(schedule, schedule.due)).toBe(true);

    const soon = retrievability(schedule, new Date(start.getTime() + MINUTE));
    const later = retrievability(
      schedule,
      new Date(start.getTime() + 60 * DAY),
    );
    expect(soon).toBeGreaterThan(later);
    expect(retrievability(newCardSchedule())).toBe(0);
  });
});
