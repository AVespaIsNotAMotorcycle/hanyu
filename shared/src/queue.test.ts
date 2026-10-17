import { describe, expect, it } from 'vitest';
import { cardKey, type Rating } from './content.js';
import {
  countIntroducedSince,
  dueCards,
  LEARN_AHEAD_MS,
  newCardAllowance,
  parseCardKey,
  parseSchedule,
  serializeSchedule,
  studyDayStart,
  summarizeCards,
} from './queue.js';
import { replayReviews } from './scheduling.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe('parseCardKey', () => {
  it('inverts cardKey', () => {
    expect(parseCardKey(cardKey('word', 'hsk30-00001', 'pinyin'))).toEqual({
      noteType: 'word',
      noteId: 'hsk30-00001',
      kind: 'pinyin',
    });
    expect(parseCardKey(cardKey('character', '学', 'handwriting'))).toEqual({
      noteType: 'character',
      noteId: '学',
      kind: 'handwriting',
    });
  });

  it('rejects malformed keys', () => {
    for (const key of [
      '',
      'word',
      'word:x',
      'deck:x:pinyin',
      'word::pinyin',
      'word:x:drawing',
    ]) {
      expect(parseCardKey(key)).toBeNull();
    }
  });
});

describe('studyDayStart', () => {
  it('starts the day at 4 a.m. local time', () => {
    // 10 a.m. in New York (UTC−4 in October).
    expect(
      studyDayStart(new Date('2026-10-16T14:00:00Z'), 'America/New_York'),
    ).toEqual(new Date('2026-10-16T08:00:00Z'));
  });

  it('counts the small hours as the previous day', () => {
    // 2 a.m. in New York on the 17th still belongs to the 16th.
    expect(
      studyDayStart(new Date('2026-10-17T06:00:00Z'), 'America/New_York'),
    ).toEqual(new Date('2026-10-16T08:00:00Z'));
  });

  it('handles time zones ahead of UTC and DST changes', () => {
    expect(
      studyDayStart(new Date('2026-10-16T01:00:00Z'), 'Asia/Shanghai'),
    ).toEqual(new Date('2026-10-15T20:00:00Z'));
    // US DST ends 2026-11-01 at 2 a.m.: 4 a.m. that day is already UTC−5.
    expect(
      studyDayStart(new Date('2026-11-01T18:00:00Z'), 'America/New_York'),
    ).toEqual(new Date('2026-11-01T09:00:00Z'));
    expect(studyDayStart(new Date('2026-10-16T03:59:00Z'), 'UTC')).toEqual(
      new Date('2026-10-15T04:00:00Z'),
    );
  });
});

describe('cards from logs', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let id = 0;
  const log = (key: string, at: Date, rating: Rating = 3) => ({
    _id: `log-${id++}`,
    cardKey: key,
    rating,
    reviewedAt: at,
  });

  // A: introduced 3 days ago, reviewed again yesterday; due in a few days.
  // B: introduced today, still in its first learning step.
  // C: introduced 30 days ago, reviewed once; long overdue.
  const logs = [
    log('A', ago(3 * DAY)),
    log('A', ago(3 * DAY - 10 * MINUTE)),
    log('A', ago(DAY)),
    log('B', ago(5 * MINUTE)),
    log('C', ago(30 * DAY)),
    log('C', ago(30 * DAY - 10 * MINUTE)),
  ];
  const summaries = summarizeCards(logs);

  it('summarizes each card with its schedule and introduction time', () => {
    expect([...summaries.keys()].sort()).toEqual(['A', 'B', 'C']);
    expect(summaries.get('A')!.introducedAt).toEqual(ago(3 * DAY));
    expect(summaries.get('A')!.schedule).toEqual(
      replayReviews(logs.slice(0, 3)),
    );
  });

  it('counts cards introduced since a time', () => {
    expect(countIntroducedSince(summaries.values(), ago(DAY))).toBe(1);
    expect(countIntroducedSince(summaries.values(), ago(60 * DAY))).toBe(3);
  });

  it('puts learning cards first, then reviews by due time', () => {
    const due = dueCards(summaries.values(), now).map((c) => c.key);
    // B is due in 5 minutes, within the learn-ahead window. A isn't due yet.
    expect(summaries.get('A')!.schedule.due.getTime()).toBeGreaterThan(
      now.getTime(),
    );
    expect(due[0]).toBe('B');
    expect(due).toContain('C');
    expect(due).not.toContain('A');
  });

  it('leaves out learning cards due beyond the learn-ahead window', () => {
    const later = summarizeCards([log('D', now, 1)]); // Again: due in 1 minute
    expect(dueCards(later.values(), now).length).toBe(1);
    const start = summarizeCards([log('E', now, 3)]); // Good: due in 10 minutes
    expect(
      dueCards(start.values(), new Date(now.getTime() - LEARN_AHEAD_MS)),
    ).toEqual([]);
  });

  it('limits new cards to what is left of the daily allowance', () => {
    expect(newCardAllowance(10, 3)).toBe(7);
    expect(newCardAllowance(10, 12)).toBe(0);
  });

  it('round-trips schedules through JSON', () => {
    const schedule = summaries.get('A')!.schedule;
    const json = JSON.parse(JSON.stringify(serializeSchedule(schedule)));
    expect(parseSchedule(json)).toEqual(schedule);
  });
});
