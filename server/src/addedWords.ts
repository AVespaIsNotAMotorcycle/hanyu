import { cardKey, MAX_ADDED_WORDS } from '@hanyu/shared';
import { ReviewLogModel } from './models/index.js';
import type { UserDocument } from './models/user.js';

/** Of these word IDs, those whose pinyin card has no reviews yet. */
async function unstarted(user: UserDocument, ids: readonly string[]) {
  const started = new Set(
    await ReviewLogModel.distinct('cardKey', {
      userId: user._id,
      cardKey: { $in: ids.map((id) => cardKey('word', id, 'pinyin')) },
    }),
  );
  return ids.filter((id) => !started.has(cardKey('word', id, 'pinyin')));
}

/**
 * Appends words to the user's added words (the next new cards), dropping
 * ones already started. Doesn't save. Returns the IDs newly added, or null
 * if they'd take the waiting list past MAX_ADDED_WORDS (nothing changes).
 */
export async function addWords(
  user: UserDocument,
  ids: readonly string[],
  { truncate = false }: { truncate?: boolean } = {},
): Promise<string[] | null> {
  const current = user.settings?.addedWords ?? [];
  const fresh = [...new Set(ids)].filter((id) => !current.includes(id));
  const pending = await unstarted(user, [...current, ...fresh]);
  let kept = pending;
  if (pending.length > MAX_ADDED_WORDS) {
    if (!truncate) return null;
    kept = pending.slice(0, MAX_ADDED_WORDS);
  }
  user.set('settings.addedWords', kept);
  return fresh.filter((id) => kept.includes(id));
}
