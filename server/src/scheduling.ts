import { replayByCard, type CardSchedule, type Rating } from '@hanyu/shared';
import type { Types } from 'mongoose';
import { ReviewLogModel } from './models/index.js';

/**
 * Recomputes a user's card states from their review logs: card state is
 * derived, never stored. Pass `cardKeys` to limit it to those cards. Cards
 * with no reviews are absent from the result (they are new).
 */
export async function loadCardSchedules(
  userId: Types.ObjectId,
  cardKeys?: readonly string[],
): Promise<Map<string, CardSchedule>> {
  const logs = await ReviewLogModel.find(
    { userId, ...(cardKeys && { cardKey: { $in: cardKeys } }) },
    { _id: 1, cardKey: 1, rating: 1, reviewedAt: 1 },
  ).lean();
  return replayByCard(
    logs.map((log) => ({ ...log, rating: log.rating as Rating })),
  );
}
