// Daily practice reminders, sent as web push. Each device subscribes on its
// own, with its own time and time zone.

import { isValidTimeZone } from './queue.js';

export const DEFAULT_REMINDER_TIME = '19:00';
/** A reminder missed this long (a dyno restart) is dropped, not sent late. */
export const REMINDER_WINDOW_MINUTES = 60;
export const MAX_PUSH_SUBSCRIPTIONS = 10;

export interface PushKeys {
  p256dh: string;
  auth: string;
}

/** GET /api/push/config. `publicKey` is null when reminders aren't set up. */
export interface PushConfigResponse {
  publicKey: string | null;
}

/** PUT /api/push/subscription: subscribes this device, or updates it. */
export interface PushSubscribeRequest {
  subscription: { endpoint: string; keys: PushKeys };
  timeZone: string;
  /** Local time, HH:MM. */
  time: string;
}

/** POST /api/push/subscription/test */
export interface PushTestRequest {
  endpoint: string;
}

/** What the service worker (client/public/push-sw.js) shows. */
export interface PushMessage {
  title: string;
  body: string;
  /** A newer message with the same tag replaces an older one. */
  tag: string;
  url: string;
}

export const REMINDER_MESSAGE: PushMessage = {
  title: '汉语 Hanyu',
  body: 'Time to practice! Your daily checklist is waiting.',
  tag: 'daily-reminder',
  url: '/',
};

export function isReminderTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// The browsers' push services. The server POSTs to whatever endpoint it's
// given, so only these are accepted: otherwise any account could point it at
// internal addresses.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const { protocol, hostname, port, username } = new URL(value);
    return (
      protocol === 'https:' &&
      !port &&
      !username &&
      PUSH_HOSTS.some((host) => host.test(hostname))
    );
  } catch {
    return false;
  }
}

export function isPushKeys(value: unknown): value is PushKeys {
  const { p256dh, auth } = (value ?? {}) as Partial<PushKeys>;
  const key = /^[A-Za-z0-9_=-]{1,256}$/;
  return (
    typeof p256dh === 'string' &&
    typeof auth === 'string' &&
    key.test(p256dh) &&
    key.test(auth)
  );
}

export function isValidPushTimeZone(value: unknown): value is string {
  return typeof value === 'string' && isValidTimeZone(value);
}

/** The calendar date (YYYY-MM-DD) and minutes past midnight in a time zone. */
export function localClock(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * The local date to send a reminder for, if one is due now: the time has
 * passed within REMINDER_WINDOW_MINUTES and today's hasn't gone out.
 */
export function reminderDue(
  subscription: { time: string; timeZone: string; lastSentOn: string | null },
  now: Date,
): string | null {
  const { date, minutes } = localClock(now, subscription.timeZone);
  const [hour, minute] = subscription.time.split(':').map(Number);
  const late = minutes - (hour! * 60 + minute!);
  if (late < 0 || late >= REMINDER_WINDOW_MINUTES) return null;
  return subscription.lastSentOn === date ? null : date;
}
