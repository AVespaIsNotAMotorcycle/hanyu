import { Router } from 'express';
import {
  isPushEndpoint,
  isPushKeys,
  isReminderTime,
  isValidPushTimeZone,
  MAX_PUSH_SUBSCRIPTIONS,
  type PushConfigResponse,
} from '@hanyu/shared';
import {
  PushSubscriptionModel,
  type StoredPushSubscription,
} from '../models/index.js';
import type { PushOptions } from '../reminders.js';

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

/** Daily reminders. `push` is null when the VAPID keys aren't set. */
export function createPushRouter(push: PushOptions | null) {
  const router = Router();

  router.get('/config', (_req, res) => {
    const body: PushConfigResponse = { publicKey: push?.publicKey ?? null };
    res.json(body);
  });

  router.use((_req, res, next) => {
    if (push) next();
    else res.status(503).json({ error: 'Reminders aren’t set up' });
  });

  // Body: PushSubscribeRequest. Also used to change the time, and to keep the
  // time zone current. A browser that changes hands moves to the new account.
  router.put('/subscription', async (req, res) => {
    const { subscription, timeZone, time } = req.body ?? {};
    const { endpoint, keys } = subscription ?? {};
    if (!isPushEndpoint(endpoint)) throw badRequest('Unknown push service');
    if (!isPushKeys(keys)) throw badRequest('Invalid subscription keys');
    if (!isValidPushTimeZone(timeZone)) throw badRequest('Invalid time zone');
    if (!isReminderTime(time)) throw badRequest('time must be HH:MM');

    const userId = req.user!._id;
    const others = await PushSubscriptionModel.countDocuments({
      userId,
      endpoint: { $ne: endpoint },
    });
    if (others >= MAX_PUSH_SUBSCRIPTIONS) {
      throw badRequest(
        `Reminders can be on for ${MAX_PUSH_SUBSCRIPTIONS} devices at most`,
      );
    }
    const existing = await PushSubscriptionModel.findOne({ endpoint }).lean();
    await PushSubscriptionModel.updateOne(
      { endpoint },
      {
        userId,
        keys,
        timeZone,
        time,
        // A new time can remind again today; refreshing the same one can't.
        lastSentOn: existing?.time === time ? existing.lastSentOn : null,
      },
      { upsert: true },
    );
    res.status(204).end();
  });

  // ?endpoint=<url>. Only the user's own devices.
  router.delete('/subscription', async (req, res) => {
    const { endpoint } = req.query;
    if (typeof endpoint !== 'string') throw badRequest('endpoint is required');
    await PushSubscriptionModel.deleteOne({ userId: req.user!._id, endpoint });
    res.status(204).end();
  });

  // Body: PushTestRequest. Sends a sample to one of the user's own devices.
  router.post('/subscription/test', async (req, res) => {
    const { endpoint } = req.body ?? {};
    const subscription =
      typeof endpoint === 'string'
        ? await PushSubscriptionModel.findOne({
            userId: req.user!._id,
            endpoint,
          }).lean<StoredPushSubscription>()
        : null;
    if (!subscription) {
      res.status(404).json({ error: 'No such subscription' });
      return;
    }
    await push!.send(subscription, {
      title: '汉语 Hanyu',
      body: 'Reminders are working.',
      tag: 'reminder-test',
      url: '/',
    });
    res.status(204).end();
  });

  return router;
}
