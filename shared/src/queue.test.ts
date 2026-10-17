import { describe, expect, it } from 'vitest';
import {
  cardKey,
  type HskLevel,
  type Rating,
  type WordNote,
} from './content.js';
import type { CharacterContent } from './dataset.js';
import {
  buildDecks,
  buildQueue,
  countIntroducedSince,
  LEECH_CLEAR_STREAK,
  LEECH_LAPSES,
  type CardSummary,
  dueCards,
  LEARN_AHEAD_MS,
  newCardAllowance,
  parseCardKey,
  parseSchedule,
  pendingAddedWords,
  serializeSchedule,
  studyDayStart,
  summarizeCards,
} from './queue.js';
import { replayReviews, type ReviewEvent } from './scheduling.js';

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

describe('leeches', () => {
  const start = new Date('2026-09-01T09:00:00Z');
  let id = 0;
  /** Replays ratings, each reviewed when the card is next due. */
  function history(ratings: Rating[]) {
    const logs: (ReviewEvent & { cardKey: string })[] = [];
    let at = start;
    for (const rating of ratings) {
      const log = { _id: `l${id++}`, cardKey: 'K', rating, reviewedAt: at };
      logs.push(log);
      at = new Date(
        Math.max(replayReviews(logs).due.getTime(), at.getTime() + MINUTE),
      );
    }
    return logs;
  }
  // Graduate (Good, Good), then lapse and relearn (Again, Good) n times.
  const lapses = (n: number): Rating[] => [
    3,
    3,
    ...Array.from({ length: n }, (): Rating[] => [1, 3]).flat(),
  ];

  it(`flags a card after ${LEECH_LAPSES} lapses`, () => {
    const below = summarizeCards(history(lapses(LEECH_LAPSES - 1))).get('K')!;
    expect(below.schedule.lapses).toBe(LEECH_LAPSES - 1);
    expect(below.leech).toBe(false);
    const at = summarizeCards(history(lapses(LEECH_LAPSES))).get('K')!;
    expect(at.schedule.lapses).toBe(LEECH_LAPSES);
    expect(at.leech).toBe(true);
  });

  it(`clears the flag after ${LEECH_CLEAR_STREAK} correct answers in a row`, () => {
    const ratings = lapses(LEECH_LAPSES);
    // The final Good of the last relearning counts toward the streak.
    const almost: Rating[] = [
      ...ratings,
      ...Array<Rating>(LEECH_CLEAR_STREAK - 2).fill(3),
    ];
    expect(summarizeCards(history(almost)).get('K')!.leech).toBe(true);
    expect(summarizeCards(history([...almost, 4])).get('K')!.leech).toBe(false);
    // Hard breaks the streak.
    expect(summarizeCards(history([...almost, 2])).get('K')!.leech).toBe(true);
  });
});

describe('buildQueue and buildDecks', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const dayStart = studyDayStart(now, 'UTC');
  const word = (n: number, level: HskLevel, levelOrder: number) =>
    ({
      _id: `w${n}`,
      level,
      levelOrder,
      simplified: `词${n}`,
      characters: [`字${n}`],
    }) as WordNote;
  const words = new Map(
    [
      word(1, 1, 2),
      word(2, 1, 3),
      word(3, 1, 1),
      word(4, 2, 1),
      word(5, 2, 2),
    ].map((w) => [w._id, w]),
  );
  let id = 0;
  const log = (noteId: string, at: Date, rating: Rating = 3) => ({
    _id: `q${id++}`,
    cardKey: cardKey('word', noteId, 'pinyin'),
    rating,
    reviewedAt: at,
  });
  const settings = {
    dailyNewCards: 10,
    levels: [1] as HskLevel[],
    handwriting: { enabled: false },
  };
  const characters = new Map<string, CharacterContent>();
  const build = (
    logs: ReturnType<typeof log>[],
    overrides: Partial<Parameters<typeof buildQueue>[0]> = {},
  ) =>
    buildQueue({
      summaries: summarizeCards(logs),
      words,
      characters,
      settings,
      now,
      dayStart,
      ...overrides,
    });

  it('introduces new cards from enabled levels in frequency order', () => {
    const queue = build([]);
    expect(queue.cards.map((c) => c.word._id)).toEqual(['w3', 'w1', 'w2']);
    expect(queue.cards[0]).toMatchObject({
      key: 'word:w3:pinyin',
      schedule: null,
      leech: false,
    });
    expect(queue).toMatchObject({
      dueCount: 0,
      newCount: 3,
      introducedToday: 0,
    });
  });

  it('puts due cards first and limits new cards per day', () => {
    const queue = build([log('w3', new Date(now.getTime() - MINUTE))], {
      settings: { ...settings, dailyNewCards: 2 },
    });
    expect(
      queue.cards.map((c) => [c.word._id, c.schedule?.phase ?? 'new']),
    ).toEqual([
      ['w3', 'learning'],
      ['w1', 'new'],
    ]);
    expect(queue).toMatchObject({
      dueCount: 1,
      newCount: 1,
      introducedToday: 1,
    });
  });

  it('introduces added words first, from any level, within the allowance', () => {
    const queue = build([log('w1', new Date(now.getTime() - MINUTE))], {
      settings: {
        ...settings,
        dailyNewCards: 3,
        // w1 is started, w9 doesn't exist: both are skipped.
        addedWords: ['w5', 'w1', 'w9', 'w2'],
      },
    });
    expect(
      queue.cards.map((c) => [c.word._id, c.schedule?.phase ?? 'new']),
    ).toEqual([
      ['w1', 'learning'],
      ['w5', 'new'],
      ['w2', 'new'],
    ]);
    expect(queue.newCount).toBe(2);
  });

  it('lists added words that are still waiting', () => {
    const summaries = summarizeCards([log('w1', now)]);
    expect(pendingAddedWords({ addedWords: ['w5', 'w1'] }, summaries)).toEqual([
      'w5',
    ]);
    expect(pendingAddedWords({}, summaries)).toEqual([]);
  });

  it('keeps reviewing started cards from disabled levels', () => {
    const queue = build([log('w4', new Date(now.getTime() - MINUTE))], {
      settings: { ...settings, levels: [] },
    });
    expect(queue.cards.map((c) => c.word._id)).toEqual(['w4']);
  });

  it('skips cards whose word is not available', () => {
    const queue = build([log('gone', new Date(now.getTime() - MINUTE))]);
    expect(queue.cards.map((c) => c.word._id)).toEqual(['w3', 'w1', 'w2']);
  });

  it('studies only leeches in flagged mode, due or not', () => {
    const leech: CardSummary = {
      ...summarizeCards([log('w2', now)]).get('word:w2:pinyin')!,
      leech: true,
    };
    leech.schedule = { ...leech.schedule, due: new Date(now.getTime() + DAY) };
    const summaries = new Map([
      ...summarizeCards([log('w1', new Date(now.getTime() - MINUTE))]),
      [leech.key, leech],
    ]);
    const queue = buildQueue({
      summaries,
      words,
      characters,
      settings,
      now,
      dayStart,
      mode: 'flagged',
    });
    expect(queue.cards.map((c) => [c.word._id, c.leech])).toEqual([
      ['w2', true],
    ]);
    expect(queue.newCount).toBe(0);
  });

  it('reports per-level progress', () => {
    const summaries = summarizeCards([
      log('w3', new Date(now.getTime() - MINUTE)),
      log('w4', new Date(now.getTime() - 40 * DAY)),
    ]);
    const decks = buildDecks({
      summaries,
      words,
      characters,
      settings,
      now,
      dataset: {
        levelCounts: { 1: 3, 2: 2, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
        characterLevelCounts: { 1: 9, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
      },
    });
    expect(decks.slice(0, 2)).toEqual([
      {
        level: 1,
        label: '1',
        enabled: true,
        total: 3,
        started: 1,
        due: 1,
        flagged: 0,
      },
      {
        level: 2,
        label: '2',
        enabled: false,
        total: 2,
        started: 1,
        due: 1,
        flagged: 0,
      },
    ]);
    expect(decks.at(-1)!.label).toBe('7–9');
  });
});

describe('handwriting cards', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const dayStart = studyDayStart(now, 'UTC');
  // 学生 introduces 学 and 生; 大学 then adds 大 (学 is already introduced).
  const words = new Map(
    [
      { _id: 'xuesheng', level: 1, levelOrder: 1, characters: ['学', '生'] },
      { _id: 'daxue', level: 1, levelOrder: 2, characters: ['大', '学'] },
      { _id: 'ren', level: 1, levelOrder: 3, characters: ['人'] },
    ].map((w) => [w._id, w as unknown as WordNote]),
  );
  const char = (id: string, introLevel: HskLevel = 1) =>
    ({
      _id: id,
      introLevel,
      strokes: [],
      medians: [],
    }) as unknown as CharacterContent;
  const characters = new Map(['学', '生', '大', '人'].map((c) => [c, char(c)]));
  let id = 0;
  const log = (key: string, minutesAgo: number, rating: Rating = 3) => ({
    _id: `h${id++}`,
    cardKey: key,
    rating,
    reviewedAt: new Date(now.getTime() - minutesAgo * MINUTE),
  });
  const settings = {
    dailyNewCards: 10,
    levels: [1] as HskLevel[],
    handwriting: { enabled: true },
  };
  const build = (
    logs: ReturnType<typeof log>[],
    overrides: Partial<Parameters<typeof buildQueue>[0]> = {},
  ) =>
    buildQueue({
      summaries: summarizeCards(logs),
      words,
      characters,
      settings,
      now,
      dayStart,
      ...overrides,
    });
  const newCards = (queue: ReturnType<typeof build>) =>
    queue.cards.filter((c) => c.schedule === null).map((c) => c.key);

  it('introduces a character once a word containing it is started', () => {
    expect(newCards(build([]))).not.toContain('character:学:handwriting');

    // 大学 was started first, so it introduces (and prompts) 大 and 学.
    const queue = build([
      log('word:daxue:pinyin', 60 * 24 * 3),
      log('word:xuesheng:pinyin', 60 * 24 * 2),
    ]);
    const handwriting = queue.cards.filter((c) => c.kind === 'handwriting');
    expect(handwriting.map((c) => [c.character!._id, c.word._id])).toEqual([
      ['大', 'daxue'],
      ['学', 'daxue'],
      ['生', 'xuesheng'],
    ]);
    expect(handwriting[0]).toMatchObject({ schedule: null, leech: false });
  });

  it('limits new handwriting cards separately from new words', () => {
    const queue = build(
      [
        log('word:xuesheng:pinyin', 60 * 24),
        log('word:daxue:pinyin', 60 * 24),
        log('character:学:handwriting', 30), // introduced today
      ],
      { settings: { ...settings, dailyNewCards: 2 } },
    );
    expect(newCards(queue)).toEqual([
      'word:ren:pinyin',
      'character:生:handwriting',
    ]);
  });

  it('reviews due handwriting cards, prompting with the introducing word', () => {
    const queue = build([
      log('word:xuesheng:pinyin', 60 * 24 * 40),
      log('character:生:handwriting', 60 * 24 * 40),
    ]);
    const due = queue.cards.find((c) => c.key === 'character:生:handwriting')!;
    expect(due.schedule?.phase).toBe('learning');
    expect(due.word._id).toBe('xuesheng');
  });

  it('suspends all handwriting cards when handwriting is off', () => {
    const logs = [
      log('word:xuesheng:pinyin', 60 * 24 * 40),
      log('character:生:handwriting', 60 * 24 * 40),
    ];
    const off = { ...settings, handwriting: { enabled: false } };
    const queue = build(logs, { settings: off });
    expect(queue.cards.some((c) => c.kind === 'handwriting')).toBe(false);
    const decks = buildDecks({
      summaries: summarizeCards(logs),
      words,
      characters,
      settings: off,
      now,
      dataset: {
        levelCounts: { 1: 3, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
        characterLevelCounts: { 1: 4, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
      },
    });
    expect(decks[0]).toMatchObject({ total: 3, started: 1 });
  });

  it('counts handwriting cards in their character’s level', () => {
    const decks = buildDecks({
      summaries: summarizeCards([
        log('word:xuesheng:pinyin', 60 * 24),
        log('character:生:handwriting', 60 * 24),
      ]),
      words,
      characters: new Map([['生', char('生', 2)]]),
      settings,
      now,
      dataset: {
        levelCounts: { 1: 3, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
        characterLevelCounts: { 1: 4, 2: 5, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
      },
    });
    expect(decks[0]).toMatchObject({ total: 7, started: 1 });
    expect(decks[1]).toMatchObject({ total: 5, started: 1 });
  });
});
