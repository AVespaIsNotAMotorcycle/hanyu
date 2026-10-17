// Recording reviews: POST /api/reviews. Logs are append-only and carry
// client-generated UUIDs, so re-sending one (a retry, or a sync from another
// device) is harmless.

import type { Rating } from './content.js';
import type { SerializedSchedule } from './queue.js';

/** Most logs accepted in one request (a sync of a long offline stretch batches). */
export const MAX_REVIEWS_PER_REQUEST = 500;
export const MAX_ANSWER_LENGTH = 200;
export const MAX_DEVICE_ID_LENGTH = 64;
/** Reviews stamped further in the future than this are rejected (clock skew allowance). */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** One review as the client records it. */
export interface ReviewInput {
  /** UUID generated on the client (crypto.randomUUID()). */
  _id: string;
  cardKey: string;
  rating: Rating;
  /** ISO timestamp of the answer. */
  reviewedAt: string;
  /** What the learner typed. */
  answer?: string;
  /** Time from showing the card to answering. */
  durationMs?: number;
  /** Identifies the browser, for telling devices apart in the logs. */
  deviceId?: string;
}

export interface PostReviewsRequest {
  reviews: ReviewInput[];
}

export interface PostReviewsResponse {
  /** IDs stored by this request. */
  accepted: string[];
  /** IDs that were already stored (re-sent logs); nothing changed. */
  duplicates: string[];
  /** Each affected card's state, replayed from every stored log. */
  cards: Record<string, SerializedSchedule>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

// --- Pulling logs (sync) --------------------------------------------------------

/** Most logs returned by one GET /api/reviews page. */
export const MAX_REVIEWS_PER_PULL = 1000;
/**
 * Clients start each pull this far before the newest `storedAt` they have
 * seen. Logs written concurrently can commit slightly out of `storedAt`
 * order; re-reading a minute covers them, and duplicates merge by `_id`.
 */
export const PULL_OVERLAP_MS = 60 * 1000;

/** A log as stored: the client's fields plus when the server stored it. */
export interface StoredReview extends ReviewInput {
  /** ISO time the server stored the log; pulls page by it. */
  storedAt: string;
}

/**
 * GET /api/reviews?since=ISO&after=ID: the user's logs stored at or after
 * `since` (and after log `after` among those stored at exactly `since`),
 * oldest first.
 */
export interface GetReviewsResponse {
  reviews: StoredReview[];
  /** Query for the next page, or null when this was the last. */
  next: { since: string; after: string } | null;
}
