import { Router, type Request } from 'express';
import {
  cardKey,
  countIntroducedSince,
  dueCards,
  HSK_LEVEL_LABELS,
  HSK_LEVELS,
  isValidTimeZone,
  newCardAllowance,
  parseCardKey,
  serializeSchedule,
  studyDayStart,
  type Deck,
  type DecksResponse,
  type HskLevel,
  type QueueCard,
  type QueueResponse,
  type WordNote,
} from '@hanyu/shared';
import { WordModel } from '../models/index.js';
import { loadCardSummaries } from '../scheduling.js';

export const studyRouter = Router();

// Phase 1 studies pinyin cards only; see ACTIVE_CARD_KINDS.
const KIND = 'pinyin';
/** Bounds a single response; a backlog beyond this shows up as cards are done. */
const MAX_DUE = 500;

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

/** The learner's IANA time zone (`?tz=`), which decides when a study day starts. */
function timeZone(req: Request): string {
  const tz = req.query.tz ?? 'UTC';
  if (typeof tz !== 'string' || !isValidTimeZone(tz)) {
    throw badRequest('tz must be an IANA time zone, e.g. America/New_York');
  }
  return tz;
}

const WORD_FIELDS = { __v: 0 } as const;

studyRouter.get('/queue', async (req, res) => {
  const user = req.user!;
  const now = new Date();
  const dayStart = studyDayStart(now, timeZone(req));
  const dailyNewCards = user.settings!.dailyNewCards;
  const levels = user.settings!.levels as HskLevel[];

  const summaries = await loadCardSummaries(user._id);
  const introducedToday = countIntroducedSince(summaries.values(), dayStart);
  const due = dueCards(summaries.values(), now).slice(0, MAX_DUE);
  const started = [...summaries.keys()].map((key) => parseCardKey(key)!.noteId);

  const [dueWords, newWords] = await Promise.all([
    WordModel.find(
      { _id: { $in: due.map((c) => parseCardKey(c.key)!.noteId) } },
      WORD_FIELDS,
    ).lean<WordNote[]>(),
    // Disabling a deck stops its new cards; started cards stay in review.
    WordModel.find(
      { level: { $in: levels }, _id: { $nin: started } },
      WORD_FIELDS,
    )
      .sort({ level: 1, levelOrder: 1 })
      .limit(newCardAllowance(dailyNewCards, introducedToday))
      .lean<WordNote[]>(),
  ]);
  const wordsById = new Map(dueWords.map((w) => [w._id, w]));

  const cards: QueueCard[] = [
    ...due.flatMap((card): QueueCard[] => {
      const word = wordsById.get(parseCardKey(card.key)!.noteId);
      // A word dropped by a reseed leaves orphaned logs; skip its card.
      return word
        ? [
            {
              key: card.key,
              kind: KIND,
              schedule: serializeSchedule(card.schedule),
              word,
            },
          ]
        : [];
    }),
    ...newWords.map((word): QueueCard => ({
      key: cardKey('word', word._id, KIND),
      kind: KIND,
      schedule: null,
      word,
    })),
  ];
  const body: QueueResponse = {
    cards,
    dueCount: cards.length - newWords.length,
    newCount: newWords.length,
    introducedToday,
    dailyNewCards,
    dayStart: dayStart.toISOString(),
  };
  res.json(body);
});

studyRouter.get('/decks', async (req, res) => {
  const user = req.user!;
  const now = new Date();
  const dayStart = studyDayStart(now, timeZone(req));
  const levels = user.settings!.levels as HskLevel[];

  const summaries = await loadCardSummaries(user._id);
  const dueKeys = new Set(dueCards(summaries.values(), now).map((c) => c.key));
  const [totals, startedWords] = await Promise.all([
    WordModel.aggregate<{ _id: HskLevel; count: number }>([
      { $group: { _id: '$level', count: { $sum: 1 } } },
    ]),
    WordModel.find(
      {
        _id: { $in: [...summaries.keys()].map((k) => parseCardKey(k)!.noteId) },
      },
      { level: 1 },
    ).lean(),
  ]);
  const levelOf = new Map(
    startedWords.map((w) => [w._id, w.level as HskLevel]),
  );

  const decks: Deck[] = HSK_LEVELS.map((level) => ({
    level,
    label: HSK_LEVEL_LABELS[level],
    enabled: levels.includes(level),
    total: totals.find((t) => t._id === level)?.count ?? 0,
    started: 0,
    due: 0,
  }));
  for (const key of summaries.keys()) {
    const level = levelOf.get(parseCardKey(key)!.noteId);
    const deck = level && decks[level - 1];
    if (!deck) continue;
    deck.started++;
    if (dueKeys.has(key)) deck.due++;
  }

  const body: DecksResponse = {
    decks,
    introducedToday: countIntroducedSince(summaries.values(), dayStart),
    dailyNewCards: user.settings!.dailyNewCards,
  };
  res.json(body);
});
