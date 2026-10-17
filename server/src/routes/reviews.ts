import { Router } from 'express';
import {
  ACTIVE_CARD_KINDS,
  isRating,
  isUuid,
  MAX_ANSWER_LENGTH,
  MAX_CLOCK_SKEW_MS,
  MAX_DEVICE_ID_LENGTH,
  MAX_REVIEWS_PER_REQUEST,
  parseCardKey,
  serializeSchedule,
  MAX_REVIEWS_PER_PULL,
  type GetReviewsResponse,
  type PostReviewsResponse,
  type Rating,
  type StoredReview,
} from '@hanyu/shared';
import { mongo, type Types } from 'mongoose';
import { CharacterModel, ReviewLogModel, WordModel } from '../models/index.js';
import { loadCardSummaries } from '../scheduling.js';

export const reviewsRouter = Router();

/** Reviews can't predate the app. */
const EARLIEST_REVIEW = Date.UTC(2026, 0, 1);

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

/** The cards that exist: a pinyin card per word, a handwriting card per character. */
const CARD_TYPES: Record<string, string> = {
  pinyin: 'word',
  handwriting: 'character',
};

interface ValidReview {
  _id: string;
  cardKey: string;
  noteType: 'word' | 'character';
  noteId: string;
  rating: Rating;
  reviewedAt: Date;
  answer?: string;
  durationMs?: number;
  deviceId?: string;
}

function validate(input: unknown, index: number, now: number): ValidReview {
  const fail = (problem: string) => badRequest(`reviews[${index}]: ${problem}`);
  if (typeof input !== 'object' || input === null) throw fail('not an object');
  const r = input as Record<string, unknown>;

  if (!isUuid(r._id)) throw fail('_id must be a lowercase UUID');
  const key = typeof r.cardKey === 'string' ? parseCardKey(r.cardKey) : null;
  if (
    !key ||
    !ACTIVE_CARD_KINDS.includes(key.kind) ||
    CARD_TYPES[key.kind] !== key.noteType
  ) {
    throw fail(
      'cardKey must be a word pinyin card or a character handwriting card',
    );
  }
  if (!isRating(r.rating)) throw fail('rating must be 1, 2, 3, or 4');
  const reviewedAt =
    typeof r.reviewedAt === 'string' ? new Date(r.reviewedAt) : null;
  const time = reviewedAt?.getTime() ?? NaN;
  if (!(time >= EARLIEST_REVIEW && time <= now + MAX_CLOCK_SKEW_MS)) {
    throw fail('reviewedAt must be an ISO time, not in the future');
  }
  if (
    r.answer !== undefined &&
    (typeof r.answer !== 'string' || r.answer.length > MAX_ANSWER_LENGTH)
  ) {
    throw fail(
      `answer must be text of at most ${MAX_ANSWER_LENGTH} characters`,
    );
  }
  if (
    r.durationMs !== undefined &&
    !(Number.isInteger(r.durationMs) && (r.durationMs as number) >= 0)
  ) {
    throw fail('durationMs must be a whole number of milliseconds');
  }
  if (
    r.deviceId !== undefined &&
    (typeof r.deviceId !== 'string' || r.deviceId.length > MAX_DEVICE_ID_LENGTH)
  ) {
    throw fail(
      `deviceId must be text of at most ${MAX_DEVICE_ID_LENGTH} characters`,
    );
  }
  return {
    _id: r._id,
    cardKey: r.cardKey as string,
    noteType: key.noteType,
    noteId: key.noteId,
    rating: r.rating,
    reviewedAt: reviewedAt!,
    answer: r.answer as string | undefined,
    durationMs: r.durationMs as number | undefined,
    deviceId: r.deviceId as string | undefined,
  };
}

/** IDs among `ids` already stored; throws 409 if any belong to someone else. */
async function existingIds(
  ids: string[],
  userId: Types.ObjectId,
): Promise<string[]> {
  const found = await ReviewLogModel.find(
    { _id: { $in: ids } },
    { userId: 1 },
  ).lean();
  if (found.some((log) => !log.userId.equals(userId))) {
    throw Object.assign(new Error('A review ID is already in use'), {
      status: 409,
      expose: true,
    });
  }
  return found.map((log) => log._id);
}

// Body: PostReviewsRequest. Stores new logs, skips ones already stored, and
// returns each affected card's state replayed from all of its logs.
reviewsRouter.post('/', async (req, res) => {
  const user = req.user!;
  const input: unknown = req.body?.reviews;
  if (!Array.isArray(input) || input.length === 0) {
    throw badRequest('reviews must be a non-empty list');
  }
  if (input.length > MAX_REVIEWS_PER_REQUEST) {
    throw badRequest(
      `Send at most ${MAX_REVIEWS_PER_REQUEST} reviews at a time`,
    );
  }
  const now = Date.now();
  const reviews = input.map((r, i) => validate(r, i, now));
  const ids = reviews.map((r) => r._id);
  if (new Set(ids).size !== ids.length)
    throw badRequest('Duplicate review IDs');

  const noteIdsOf = (type: ValidReview['noteType']) => [
    ...new Set(reviews.filter((r) => r.noteType === type).map((r) => r.noteId)),
  ];
  const [wordIds, characterIds] = [noteIdsOf('word'), noteIdsOf('character')];
  const [words, characters] = await Promise.all([
    WordModel.countDocuments({ _id: { $in: wordIds } }),
    CharacterModel.countDocuments({ _id: { $in: characterIds } }),
  ]);
  if (words !== wordIds.length) throw badRequest('Unknown word in cardKey');
  if (characters !== characterIds.length) {
    throw badRequest('Unknown character in cardKey');
  }

  const already = new Set(await existingIds(ids, user._id));
  const fresh = reviews.filter((r) => !already.has(r._id));
  try {
    await ReviewLogModel.insertMany(
      fresh.map(({ noteId: _, noteType: __, ...log }) => ({
        ...log,
        userId: user._id,
      })),
      { ordered: false },
    );
  } catch (err) {
    // A concurrent request (a retry racing the original) stored some first.
    // Those inserts fail as duplicate keys; the rest went through.
    if (!(err instanceof mongo.MongoBulkWriteError)) throw err;
    // Mongoose rewraps the driver's WriteErrors as `{ err, index }`.
    const writeErrors = [err.writeErrors].flat() as unknown as {
      index: number;
      code?: number;
      err?: { code?: number };
    }[];
    const duplicate = (e: (typeof writeErrors)[number]) =>
      (e.code ?? e.err?.code) === 11000;
    if (!writeErrors.every(duplicate)) throw err;
    const raced = writeErrors.map((e) => fresh[e.index]!._id);
    for (const id of await existingIds(raced, user._id)) already.add(id);
  }

  const cardKeys = [...new Set(reviews.map((r) => r.cardKey))];
  const summaries = await loadCardSummaries(user._id, cardKeys);
  const body: PostReviewsResponse = {
    accepted: ids.filter((id) => !already.has(id)),
    duplicates: ids.filter((id) => already.has(id)),
    cards: Object.fromEntries(
      [...summaries].map(([key, s]) => [key, serializeSchedule(s.schedule)]),
    ),
  };
  res.json(body);
});

// Sync pull: the user's logs in the order they were stored, a page at a time.
// Query: since (ISO, inclusive), after (log ID, for ties at `since`).
reviewsRouter.get('/', async (req, res) => {
  const user = req.user!;
  const { since, after } = req.query;
  const from = since === undefined ? new Date(0) : new Date(String(since));
  if (Number.isNaN(from.getTime()))
    throw badRequest('since must be an ISO time');
  if (after !== undefined && (since === undefined || !isUuid(after))) {
    throw badRequest('after must be a review ID, together with since');
  }

  const logs = await ReviewLogModel.find({
    userId: user._id,
    ...(after
      ? {
          $or: [
            { createdAt: { $gt: from } },
            { createdAt: from, _id: { $gt: after } },
          ],
        }
      : { createdAt: { $gte: from } }),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(MAX_REVIEWS_PER_PULL + 1)
    .lean();

  const page = logs.slice(0, MAX_REVIEWS_PER_PULL);
  const last = page.at(-1);
  const body: GetReviewsResponse = {
    reviews: page.map((log): StoredReview => ({
      _id: log._id,
      cardKey: log.cardKey,
      rating: log.rating as Rating,
      reviewedAt: log.reviewedAt.toISOString(),
      ...(log.answer != null && { answer: log.answer }),
      ...(log.durationMs != null && { durationMs: log.durationMs }),
      ...(log.deviceId != null && { deviceId: log.deviceId }),
      storedAt: log.createdAt!.toISOString(),
    })),
    next:
      logs.length > MAX_REVIEWS_PER_PULL && last
        ? { since: last.createdAt!.toISOString(), after: last._id }
        : null,
  };
  res.json(body);
});
