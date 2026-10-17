// The review queue: which cards are due, how many new cards are left today,
// and when "today" starts. Pure functions over review logs, so the server
// (and later the offline client) build the same queue.

import {
  cardKey,
  type CardKind,
  type HskLevel,
  type NoteType,
  type WordNote,
} from './content.js';
import type { CharacterContent, DatasetResponse } from './dataset.js';
import type { HandwritingSettings } from './handwriting.js';
import {
  compareReviews,
  replayReviews,
  type CardSchedule,
  type ReviewEvent,
} from './scheduling.js';

/** Card kinds that are studied. Meaning cards come later. */
export const ACTIVE_CARD_KINDS: readonly CardKind[] = ['pinyin', 'handwriting'];

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

/** A card is a leech once it has lapsed this many times… */
export const LEECH_LAPSES = 4;
/** …until it is answered correctly (Good or Easy) this many times in a row. */
export const LEECH_CLEAR_STREAK = 3;

export interface CardSummary {
  key: string;
  schedule: CardSchedule;
  /** When the card was first reviewed, i.e. introduced. */
  introducedAt: Date;
  /** Failed repeatedly; see LEECH_LAPSES. Derived from logs like the schedule. */
  leech: boolean;
}

/**
 * Whether a card with these reviews (sorted) is a leech: it has lapsed
 * LEECH_LAPSES times and hasn't since been answered correctly
 * LEECH_CLEAR_STREAK times in a row.
 */
export function isLeech(
  schedule: CardSchedule,
  sortedReviews: readonly Pick<ReviewEvent, 'rating'>[],
): boolean {
  if (schedule.lapses < LEECH_LAPSES) return false;
  let streak = 0;
  for (let i = sortedReviews.length - 1; i >= 0; i--) {
    if (sortedReviews[i]!.rating < 3) break;
    streak++;
  }
  return streak < LEECH_CLEAR_STREAK;
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
    const sorted = [...list].sort(compareReviews);
    const schedule = replayReviews(sorted);
    summaries.set(key, {
      key,
      schedule,
      introducedAt: new Date(sorted[0]!.reviewedAt),
      leech: isLeech(schedule, sorted),
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

// --- Building the queue and decks -------------------------------------------

/** `regular`: due cards, then today's new cards. `flagged`: leeches only. */
export type StudyMode = 'regular' | 'flagged';

export interface QueueItem {
  key: string;
  kind: CardKind;
  /** Null for a new card. */
  schedule: CardSchedule | null;
  leech: boolean;
  /**
   * Pinyin cards: the word to read. Handwriting cards: the word that
   * introduced the character, shown with a blank where the character goes.
   */
  word: WordNote;
  /** Handwriting cards: the character to draw. */
  character: CharacterContent | null;
}

export interface StudyQueue {
  /** Due cards first ((re)learning, then review), then today's new cards. */
  cards: QueueItem[];
  dueCount: number;
  newCount: number;
  /** Cards introduced today, all kinds. */
  introducedToday: number;
}

export interface StudySettings {
  /** New cards per study day, for each card kind. */
  dailyNewCards: number;
  levels: readonly HskLevel[];
  handwriting: Pick<HandwritingSettings, 'enabled'>;
  /**
   * Words added from reading ("add to SRS"), oldest first. Unstarted ones
   * are the first new cards, from any level.
   */
  addedWords?: readonly string[];
}

export interface QueueInput {
  /** The user's cards, from summarizeCards. */
  summaries: ReadonlyMap<string, CardSummary>;
  /**
   * Words by ID: at least every started card's word, every added word, and
   * every word in the enabled levels. Cards whose word is missing are skipped.
   */
  words: ReadonlyMap<string, WordNote>;
  /** Characters by ID: at least those of started words. */
  characters: ReadonlyMap<string, CharacterContent>;
  settings: StudySettings;
  now: Date;
  /** Start of the study day (studyDayStart). */
  dayStart: Date;
  mode?: StudyMode;
}

/**
 * The cards a learner can have, given their settings: word pinyin cards
 * always, character handwriting cards when handwriting is on.
 */
export function studiedKinds(settings: StudySettings): CardKind[] {
  return ACTIVE_CARD_KINDS.filter(
    (kind) => kind !== 'handwriting' || settings.handwriting.enabled,
  );
}

/**
 * Each started word's ID, earliest introduced first. A character's
 * handwriting card is introduced by (and prompted with) the first of these
 * that contains it.
 */
function startedWords(
  summaries: ReadonlyMap<string, CardSummary>,
  words: ReadonlyMap<string, WordNote>,
): WordNote[] {
  return [...summaries.values()]
    .filter((s) => parseCardKey(s.key)?.kind === 'pinyin')
    .sort((a, b) => a.introducedAt.getTime() - b.introducedAt.getTime())
    .flatMap((s) => words.get(parseCardKey(s.key)!.noteId) ?? []);
}

/** Builds what to study now. Pure, so every device builds the same queue. */
export function buildQueue({
  summaries,
  words,
  characters,
  settings,
  now,
  dayStart,
  mode = 'regular',
}: QueueInput): StudyQueue {
  const kinds = studiedKinds(settings);
  const studied = [...summaries.values()].filter((s) =>
    kinds.includes(parseCardKey(s.key)?.kind as CardKind),
  );
  const introducedToday = countIntroducedSince(studied, dayStart);
  const introducedTodayOf = (kind: CardKind) =>
    countIntroducedSince(
      studied.filter((s) => parseCardKey(s.key)?.kind === kind),
      dayStart,
    );

  const started = startedWords(summaries, words);
  const promptWord = new Map<string, WordNote>();
  for (const word of started) {
    for (const char of word.characters) {
      if (!promptWord.has(char)) promptWord.set(char, word);
    }
  }

  const item = (summary: CardSummary): QueueItem[] => {
    const key = parseCardKey(summary.key);
    if (!key) return [];
    const common = {
      key: summary.key,
      kind: key.kind,
      schedule: summary.schedule,
      leech: summary.leech,
    };
    if (key.kind === 'handwriting') {
      const character = characters.get(key.noteId);
      const word = promptWord.get(key.noteId);
      return character && word ? [{ ...common, word, character }] : [];
    }
    const word = words.get(key.noteId);
    return word ? [{ ...common, word, character: null }] : [];
  };

  if (mode === 'flagged') {
    // Every leech, most overdue first, whether or not it's due.
    const cards = studied
      .filter((s) => s.leech)
      .sort((a, b) => a.schedule.due.getTime() - b.schedule.due.getTime())
      .flatMap(item);
    return { cards, dueCount: cards.length, newCount: 0, introducedToday };
  }

  const due = dueCards(studied, now).flatMap(item);

  // New pinyin cards: added words, then unstarted words from enabled levels,
  // most frequent first.
  const startedIds = new Set(started.map((w) => w._id));
  const added = [...new Set(settings.addedWords ?? [])].flatMap((id) => {
    const word = words.get(id);
    return word && !startedIds.has(id) ? [word] : [];
  });
  const addedIds = new Set(added.map((w) => w._id));
  const levelWords = [...words.values()]
    .filter(
      (w) =>
        settings.levels.includes(w.level) &&
        !startedIds.has(w._id) &&
        !addedIds.has(w._id),
    )
    .sort((a, b) => a.level - b.level || a.levelOrder - b.levelOrder);
  const newWords = [...added, ...levelWords]
    .slice(
      0,
      newCardAllowance(settings.dailyNewCards, introducedTodayOf('pinyin')),
    )
    .map((word): QueueItem => ({
      key: cardKey('word', word._id, 'pinyin'),
      kind: 'pinyin',
      schedule: null,
      leech: false,
      word,
      character: null,
    }));

  // New handwriting cards: characters of started words, in the order the
  // words were introduced.
  const newCharacters: QueueItem[] = [];
  if (kinds.includes('handwriting')) {
    const allowance = newCardAllowance(
      settings.dailyNewCards,
      introducedTodayOf('handwriting'),
    );
    for (const [char, word] of promptWord) {
      if (newCharacters.length >= allowance) break;
      const key = cardKey('character', char, 'handwriting');
      const character = characters.get(char);
      if (summaries.has(key) || !character) continue;
      newCharacters.push({
        key,
        kind: 'handwriting',
        schedule: null,
        leech: false,
        word,
        character,
      });
    }
  }

  const fresh = [...newWords, ...newCharacters];
  return {
    cards: [...due, ...fresh],
    dueCount: due.length,
    newCount: fresh.length,
    introducedToday,
  };
}

export interface Deck {
  level: HskLevel;
  label: string;
  /** New cards are introduced only from enabled decks. */
  enabled: boolean;
  /** Cards in the deck: a pinyin card per word, plus a handwriting card per character introduced at this level when handwriting is on. */
  total: number;
  /** Cards reviewed at least once. */
  started: number;
  /** Cards due now. */
  due: number;
  /** Leeches. */
  flagged: number;
}

/**
 * Per-level progress. Pinyin cards belong to their word's level and
 * handwriting cards to their character's `introLevel`.
 */
export function buildDecks({
  summaries,
  words,
  characters,
  settings,
  dataset,
  now,
}: Omit<QueueInput, 'dayStart' | 'mode'> & {
  dataset: Pick<DatasetResponse, 'levelCounts' | 'characterLevelCounts'>;
}): Deck[] {
  const kinds = studiedKinds(settings);
  const decks = HSK_LEVELS.map((level): Deck => ({
    level,
    label: HSK_LEVEL_LABELS[level],
    enabled: settings.levels.includes(level),
    total:
      (dataset.levelCounts[level] ?? 0) +
      (kinds.includes('handwriting')
        ? (dataset.characterLevelCounts[level] ?? 0)
        : 0),
    started: 0,
    due: 0,
    flagged: 0,
  }));
  const studied = [...summaries.values()].filter((s) =>
    kinds.includes(parseCardKey(s.key)?.kind as CardKind),
  );
  const due = new Set(dueCards(studied, now).map((c) => c.key));
  for (const summary of studied) {
    const key = parseCardKey(summary.key)!;
    const level =
      key.kind === 'handwriting'
        ? characters.get(key.noteId)?.introLevel
        : words.get(key.noteId)?.level;
    const deck = level && decks[level - 1];
    if (!deck) continue;
    deck.started++;
    if (due.has(summary.key)) deck.due++;
    if (summary.leech) deck.flagged++;
  }
  return decks;
}

/** Most unstarted added words a user can have waiting. */
export const MAX_ADDED_WORDS = 500;

/** POST /api/settings/added-words. Returns AuthResponse. */
export interface AddWordRequest {
  wordId: string;
}

/** Added words that haven't been started yet, oldest first. */
export function pendingAddedWords(
  settings: Pick<StudySettings, 'addedWords'>,
  summaries: ReadonlyMap<string, CardSummary>,
): string[] {
  return (settings.addedWords ?? []).filter(
    (id) => !summaries.has(cardKey('word', id, 'pinyin')),
  );
}

/** PUT /api/settings. Returns AuthResponse. Fields left out are unchanged. */
export interface UpdateSettingsRequest {
  dailyNewCards?: number;
  levels?: HskLevel[];
  handwriting?: Partial<HandwritingSettings>;
}
