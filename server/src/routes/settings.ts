import { Router } from 'express';
import {
  cardKey,
  HSK_LEVELS,
  isHskLevel,
  MAX_ADDED_WORDS,
  MAX_ALLOWED_MISSES,
  MAX_DAILY_NEW_CARDS,
  type AuthResponse,
} from '@hanyu/shared';
import { ReviewLogModel, WordModel } from '../models/index.js';
import { toAuthUser, type UserDocument } from '../models/user.js';

export const settingsRouter = Router();

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

// Body: UpdateSettingsRequest. Fields left out are unchanged.
settingsRouter.put('/', async (req, res) => {
  const { dailyNewCards, levels, handwriting } = req.body ?? {};
  const user = req.user!;

  if (dailyNewCards !== undefined) {
    if (
      !Number.isInteger(dailyNewCards) ||
      dailyNewCards < 0 ||
      dailyNewCards > MAX_DAILY_NEW_CARDS
    ) {
      throw badRequest(
        `dailyNewCards must be a whole number from 0 to ${MAX_DAILY_NEW_CARDS}`,
      );
    }
    user.set('settings.dailyNewCards', dailyNewCards);
  }
  if (levels !== undefined) {
    if (!Array.isArray(levels) || !levels.every(isHskLevel)) {
      throw badRequest('levels must be a list of HSK levels from 1 to 7');
    }
    // Store sorted and deduplicated.
    user.set(
      'settings.levels',
      HSK_LEVELS.filter((level) => levels.includes(level)),
    );
  }

  if (handwriting !== undefined) {
    if (typeof handwriting !== 'object' || handwriting === null) {
      throw badRequest('handwriting must be an object');
    }
    const { enabled, strokeOrder, allowedMisses } = handwriting;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw badRequest('handwriting.enabled must be true or false');
    }
    if (
      strokeOrder !== undefined &&
      strokeOrder !== 'strict' &&
      strokeOrder !== 'lenient'
    ) {
      throw badRequest('handwriting.strokeOrder must be strict or lenient');
    }
    if (
      allowedMisses !== undefined &&
      !(
        Number.isInteger(allowedMisses) &&
        allowedMisses >= 0 &&
        allowedMisses <= MAX_ALLOWED_MISSES
      )
    ) {
      throw badRequest(
        `handwriting.allowedMisses must be a whole number from 0 to ${MAX_ALLOWED_MISSES}`,
      );
    }
    for (const [field, value] of Object.entries({
      enabled,
      strokeOrder,
      allowedMisses,
    })) {
      if (value !== undefined) user.set(`settings.handwriting.${field}`, value);
    }
  }

  await user.save();
  const body: AuthResponse = { user: toAuthUser(user) };
  res.json(body);
});

/** Added words whose pinyin card has no reviews yet (started ones are dropped). */
async function unstarted(user: UserDocument, ids: readonly string[]) {
  const started = new Set(
    await ReviewLogModel.distinct('cardKey', {
      userId: user._id,
      cardKey: { $in: ids.map((id) => cardKey('word', id, 'pinyin')) },
    }),
  );
  return ids.filter((id) => !started.has(cardKey('word', id, 'pinyin')));
}

// "Add to SRS" from reading. Body: AddWordRequest. The word becomes the next
// new card (see buildQueue); adding a started or already-added word is a no-op.
settingsRouter.post('/added-words', async (req, res) => {
  const wordId: unknown = req.body?.wordId;
  if (typeof wordId !== 'string' || !wordId) {
    throw badRequest('wordId must be a word ID');
  }
  if (!(await WordModel.exists({ _id: wordId }))) {
    res.status(404).json({ error: 'No such word' });
    return;
  }
  const user = req.user!;
  const current = user.settings?.addedWords ?? [];
  const pending = await unstarted(user, [...new Set([...current, wordId])]);
  if (pending.length > MAX_ADDED_WORDS) {
    throw badRequest(
      `At most ${MAX_ADDED_WORDS} added words can wait at once; study some first`,
    );
  }
  user.set('settings.addedWords', pending);
  await user.save();
  const body: AuthResponse = { user: toAuthUser(user) };
  res.json(body);
});

settingsRouter.delete('/added-words/:wordId', async (req, res) => {
  const user = req.user!;
  user.set(
    'settings.addedWords',
    (user.settings?.addedWords ?? []).filter((id) => id !== req.params.wordId),
  );
  await user.save();
  const body: AuthResponse = { user: toAuthUser(user) };
  res.json(body);
});
