// The review queue: which cards are due, how many new cards are left today,
// and when "today" starts. Pure functions over review logs, so the server
// (and later the offline client) build the same queue.

import type { CardKind, HskLevel, NoteType, WordNote } from './content.js';
import {
  compareReviews,
  replayReviews,
  type CardSchedule,
  type ReviewEvent,
} from './scheduling.js';

/** Card kinds that are studied today. Meaning and handwriting cards come later. */
export const ACTIVE_CARD_KINDS: readonly CardKind[] = ['pinyin'];

export const HSK_LEVELS: readonly HskLevel[] = [1, 2, 3, 4, 5, 6, 7];
export const HSK_LEVEL_LABELS: Record<HskLevel, string> = {
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7–9',
};

export const DEFAULT_DAILY_NEW_CARDS = 10;
export const MAX_DAILY_NEW_CARDS = 200;
export const DEFAULT_LEVELS: readonly HskLevel[] = [1];

/** A study day runs from 4 a.m. to 4 a.m. local time, so late nights count as the day before. */
export const DAY_START_HOUR = 4;

/** Learning cards due within this window are shown early rather than making the learner wait. */
export const LEARN_AHEAD_MS = 20 * 60 * 1000;

export function isHskLevel(value: unknown): value is HskLevel {
  return HSK_LEVELS.includes(value as HskLevel);
}

const NOTE_TYPES: readonly NoteType[] = ['word', 'character'];
const CARD_KINDS: readonly CardKind[] = ['pinyin', 'meaning', 'handwriting'];

/** Inverse of `cardKey`. Returns null for malformed keys. */
export function parseCardKey(
  key: string,
): { noteType: NoteType; noteId: string; kind: CardKind } | null {
  const first = key.indexOf(':');
  const last = key.lastIndexOf(':');
  if (first <= 0 || last === first) return null;
  const noteType = key.slice(0, first) as NoteType;
  const noteId = key.slice(first + 1, last);
  const kind = key.slice(last + 1) as CardKind;
  if (!NOTE_TYPES.includes(noteType) || !CARD_KINDS.includes(kind) || !noteId)
    return null;
  return { noteType, noteId, kind };
}

// --- Study days ---------------------------------------------------------------

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone` is ahead of UTC at `date`, in milliseconds. */
function utcOffset(timeZone: string, date: Date): number {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(date).map((p) => [p.type, Number(p.value)]),
  );
  const local = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return local - Math.floor(date.getTime() / 1000) * 1000;
}

/** When the study day containing `now` began (4 a.m. local time). */
export function studyDayStart(
  now: Date,
  timeZone: string,
  dayStartHour: number = DAY_START_HOUR,
): Date {
  // The local calendar date of (now − 4 h) is the study day's date.
  const shifted = new Date(now.getTime() - dayStartHour * 60 * 60 * 1000);
  const local = new Date(shifted.getTime() + utcOffset(timeZone, shifted));
  const guess = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    dayStartHour,
  );
  // Convert local 4 a.m. to UTC; re-check the offset in case DST changed.
  let start = guess - utcOffset(timeZone, new Date(guess));
  start = guess - utcOffset(timeZone, new Date(start));
  return new Date(start);
}

// --- Cards from logs ----------------------------------------------------------

export interface CardSummary {
  key: string;
  schedule: CardSchedule;
  /** When the card was first reviewed, i.e. introduced. */
  introducedAt: Date;
}

/** Replays a user's logs into one summary per card key. */
export function summarizeCards(
  reviews: Iterable<ReviewEvent & { cardKey: string }>,
): Map<string, CardSummary> {
  const byCard = new Map<string, ReviewEvent[]>();
  for (const review of reviews) {
    const list = byCard.get(review.cardKey);
    if (list) list.push(review);
    else byCard.set(review.cardKey, [review]);
  }
  const summaries = new Map<string, CardSummary>();
  for (const [key, list] of byCard) {
    const first = [...list].sort(compareReviews)[0]!;
    summaries.set(key, {
      key,
      schedule: replayReviews(list),
      introducedAt: new Date(first.reviewedAt),
    });
  }
  return summaries;
}

/** How many cards were introduced (first reviewed) at or after `since`. */
export function countIntroducedSince(
  summaries: Iterable<CardSummary>,
  since: Date,
): number {
  let count = 0;
  for (const { introducedAt } of summaries) {
    if (introducedAt.getTime() >= since.getTime()) count++;
  }
  return count;
}

/** New cards still allowed today. */
export function newCardAllowance(
  dailyNewCards: number,
  introducedToday: number,
): number {
  return Math.max(0, dailyNewCards - introducedToday);
}

const isLearning = (s: CardSchedule) =>
  s.phase === 'learning' || s.phase === 'relearning';

/**
 * Cards to review now, in order: (re)learning cards first (including ones
 * due within LEARN_AHEAD_MS), then review cards, each by due time.
 */
export function dueCards(
  summaries: Iterable<CardSummary>,
  now: Date,
): CardSummary[] {
  const due = [...summaries].filter(({ schedule }) => {
    if (schedule.phase === 'new') return false;
    const ahead = isLearning(schedule) ? LEARN_AHEAD_MS : 0;
    return schedule.due.getTime() <= now.getTime() + ahead;
  });
  return due.sort(
    (a, b) =>
      Number(isLearning(b.schedule)) - Number(isLearning(a.schedule)) ||
      a.schedule.due.getTime() - b.schedule.due.getTime(),
  );
}

// --- API shapes ---------------------------------------------------------------

/** CardSchedule as JSON: dates are ISO strings. */
export interface SerializedSchedule extends Omit<
  CardSchedule,
  'due' | 'lastReview'
> {
  due: string;
  lastReview: string | null;
}

export function serializeSchedule(schedule: CardSchedule): SerializedSchedule {
  return {
    ...schedule,
    due: schedule.due.toISOString(),
    lastReview: schedule.lastReview?.toISOString() ?? null,
  };
}

export function parseSchedule(json: SerializedSchedule): CardSchedule {
  return {
    ...json,
    due: new Date(json.due),
    lastReview: json.lastReview ? new Date(json.lastReview) : null,
  };
}

export interface QueueCard {
  key: string;
  kind: CardKind;
  /** Null for a new card. */
  schedule: SerializedSchedule | null;
  word: WordNote;
}

/** GET /api/queue?tz=… */
export interface QueueResponse {
  /** Due cards first ((re)learning, then review), then today's new cards. */
  cards: QueueCard[];
  dueCount: number;
  newCount: number;
  introducedToday: number;
  dailyNewCards: number;
  /** Start of the current study day (ISO). */
  dayStart: string;
}

export interface Deck {
  level: HskLevel;
  label: string;
  /** New cards are introduced only from enabled decks. */
  enabled: boolean;
  /** Cards in the deck (one per word per active card kind). */
  total: number;
  /** Cards reviewed at least once. */
  started: number;
  /** Cards due now. */
  due: number;
}

/** GET /api/decks?tz=… */
export interface DecksResponse {
  decks: Deck[];
  introducedToday: number;
  dailyNewCards: number;
}

/** PUT /api/settings. Returns AuthResponse. */
export interface UpdateSettingsRequest {
  dailyNewCards?: number;
  levels?: HskLevel[];
}
