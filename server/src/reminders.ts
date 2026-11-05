import {
  REMINDER_MESSAGE,
  reminderDue,
  studyDayStart,
  type PushKeys,
  type PushMessage,
} from '@hanyu/shared';
import type { Types } from 'mongoose';
import webpush from 'web-push';
import {
  PushSubscriptionModel,
  QuestionAnswerModel,
  ReviewLogModel,
  TranslationGradingModel,
  type StoredPushSubscription,
} from './models/index.js';

const CHECK_MS = 60 * 1000;

export type PushSender = (
  subscription: { endpoint: string; keys: PushKeys },
  message: PushMessage,
) => Promise<void>;

export interface PushOptions {
  publicKey: string;
  send: PushSender;
}

/** Sends through the browsers' push services, signed with the VAPID keys. */
export function createPushOptions(vapid: {
  publicKey: string;
  privateKey: string;
  subject: string;
}): PushOptions {
  const { publicKey, privateKey, subject } = vapid;
  const vapidDetails = { subject, publicKey, privateKey };
  return {
    publicKey,
    send: async (subscription, message) => {
      await webpush.sendNotification(subscription, JSON.stringify(message), {
        vapidDetails,
        // A reminder is no use once the day has moved on.
        TTL: 60 * 60,
      });
    },
  };
}

/** Whether a user has done anything since this study day began. */
async function studiedSince(userId: Types.ObjectId, since: Date) {
  const [review, answer, translation] = await Promise.all([
    ReviewLogModel.exists({ userId, reviewedAt: { $gte: since } }),
    QuestionAnswerModel.exists({ userId, createdAt: { $gte: since } }),
    TranslationGradingModel.exists({
      userId,
      status: 'graded',
      createdAt: { $gte: since },
    }),
  ]);
  return Boolean(review || answer || translation);
}

/** Whether the push service says this subscription is gone for good. */
const isGone = (err: unknown) => {
  const status = (err as { statusCode?: number })?.statusCode;
  return status === 404 || status === 410;
};

/**
 * Sends today's reminders that are due, skipping anyone who has already
 * practiced. Each is claimed before sending, so an overlapping run can't
 * send it twice.
 */
export async function sendReminders(send: PushSender, now = new Date()) {
  let sent = 0;
  const subscriptions =
    await PushSubscriptionModel.find().lean<StoredPushSubscription[]>();
  for (const subscription of subscriptions) {
    const date = reminderDue(subscription, now);
    if (!date) continue;
    const claim = await PushSubscriptionModel.updateOne(
      { _id: subscription._id, lastSentOn: subscription.lastSentOn },
      { lastSentOn: date },
    );
    if (claim.modifiedCount === 0) continue;
    const since = studyDayStart(now, subscription.timeZone);
    if (await studiedSince(subscription.userId, since)) continue;
    try {
      await send(subscription, REMINDER_MESSAGE);
      sent++;
    } catch (err) {
      if (isGone(err)) {
        await PushSubscriptionModel.deleteOne({ _id: subscription._id });
      } else {
        // Not the endpoint: it identifies the device.
        console.error('Reminder failed:', (err as Error)?.message);
      }
    }
  }
  return sent;
}

/** Checks for due reminders every minute, for as long as the server runs. */
export function startReminders(send: PushSender) {
  const timer = setInterval(() => {
    sendReminders(send).catch((err: unknown) => {
      console.error('Reminder check failed:', err);
    });
  }, CHECK_MS);
  timer.unref();
}
