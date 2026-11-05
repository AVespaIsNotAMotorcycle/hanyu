import type { PushKeys } from '@hanyu/shared';
import { model, Schema, type Types } from 'mongoose';

export interface StoredPushSubscription {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  endpoint: string;
  keys: PushKeys;
  timeZone: string;
  time: string;
  lastSentOn: string | null;
}

// One device's subscription to daily reminders.
const pushSubscriptionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    timeZone: { type: String, required: true },
    /** Local time to remind at, HH:MM. */
    time: { type: String, required: true },
    /** The local date of the last reminder, so each day gets one. */
    lastSentOn: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

pushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });
pushSubscriptionSchema.index({ userId: 1 });

export const PushSubscriptionModel = model(
  'PushSubscription',
  pushSubscriptionSchema,
);
