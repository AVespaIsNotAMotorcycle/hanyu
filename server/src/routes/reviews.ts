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
  type PostReviewsResponse,
  type Rating,
} from '@hanyu/shared';
import { mongo, type Types } from 'mongoose';
import { ReviewLogModel, WordModel } from '../models/index.js';
import { loadCardSummaries } from '../scheduling.js';

export const reviewsRouter = Router();

/** Reviews can't predate the app. */
const EARLIEST_REVIEW = Date.UTC(2026, 0, 1);

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

interface ValidReview {
  _id: string;
  cardKey: string;
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
    key.noteType !== 'word' ||
    !ACTIVE_CARD_KINDS.includes(key.kind)
  ) {
    throw fail(
      `cardKey must be a word card of kind ${ACTIVE_CARD_KINDS.join(', ')}`,
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

  const noteIds = [...new Set(reviews.map((r) => r.noteId))];
  const known = await WordModel.countDocuments({ _id: { $in: noteIds } });
  if (known !== noteIds.length) throw badRequest('Unknown word in cardKey');

  const already = new Set(await existingIds(ids, user._id));
  const fresh = reviews.filter((r) => !already.has(r._id));
  try {
    await ReviewLogModel.insertMany(
      fresh.map(({ noteId: _, ...log }) => ({ ...log, userId: user._id })),
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
