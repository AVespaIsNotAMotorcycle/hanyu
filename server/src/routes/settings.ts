import { Router } from 'express';
import {
  HSK_LEVELS,
  isHskLevel,
  MAX_ALLOWED_MISSES,
  MAX_DAILY_NEW_CARDS,
  type AuthResponse,
} from '@hanyu/shared';
import { toAuthUser } from '../models/user.js';

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
