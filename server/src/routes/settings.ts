import { Router } from 'express';
import {
  HSK_LEVELS,
  isHskLevel,
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
  const { dailyNewCards, levels } = req.body ?? {};
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

  await user.save();
  const body: AuthResponse = { user: toAuthUser(user) };
  res.json(body);
});
