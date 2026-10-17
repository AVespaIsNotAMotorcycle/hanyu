import {
  ACTIVE_CARD_KINDS,
  summarizeCards,
  type CardSummary,
  type Rating,
} from '@hanyu/shared';
import type { Types } from 'mongoose';
import { ReviewLogModel } from './models/index.js';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Recomputes a user's cards from their review logs: card state is derived,
 * never stored. Pass `cardKeys` to limit it to those cards; by default it
 * covers every card of the active kinds. Cards with no reviews are absent
 * from the result (they are new).
 */
export async function loadCardSummaries(
  userId: Types.ObjectId,
  cardKeys?: readonly string[],
): Promise<Map<string, CardSummary>> {
  const activeKinds = new RegExp(
    `:(${ACTIVE_CARD_KINDS.map(escape).join('|')})$`,
  );
  const logs = await ReviewLogModel.find(
    {
      userId,
      cardKey: cardKeys ? { $in: cardKeys } : activeKinds,
    },
    { _id: 1, cardKey: 1, rating: 1, reviewedAt: 1 },
  ).lean();
  return summarizeCards(
    logs.map((log) => ({ ...log, rating: log.rating as Rating })),
  );
}
