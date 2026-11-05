// This device's reminder subscription. Push needs the production service
// worker, so in `npm run dev` reminders report themselves unavailable.

import {
  DEFAULT_REMINDER_TIME,
  type PushConfigResponse,
  type PushKeys,
  type PushSubscribeRequest,
} from '@hanyu/shared';
import { deleteJson, getJson, postJson, putJson, timeZone } from '../api';

const TIME = 'hanyu.reminderTime';

export function savedReminderTime(): string {
  try {
    return localStorage.getItem(TIME) ?? DEFAULT_REMINDER_TIME;
  } catch {
    return DEFAULT_REMINDER_TIME;
  }
}

function saveReminderTime(time: string) {
  try {
    localStorage.setItem(TIME, time);
  } catch {
    // Storage unavailable: the server still has it for this session.
  }
}

export const pushSupported = () =>
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

async function registration() {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** VAPID keys are base64url; the browser wants bytes. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function register(subscription: PushSubscription, time: string) {
  const { endpoint, keys } = subscription.toJSON();
  const body: PushSubscribeRequest = {
    subscription: { endpoint: endpoint!, keys: keys as unknown as PushKeys },
    timeZone,
    time,
  };
  await putJson('/push/subscription', body);
  saveReminderTime(time);
}

export type ReminderState =
  /** This browser can't, or (iPhone) can't until the app is installed. */
  | 'unsupported'
  /** The server has no VAPID keys. */
  | 'unavailable'
  /** The browser's notification permission was refused. */
  | 'blocked'
  | 'off'
  | 'on';

/** Where reminders stand here. If on, refreshes the time zone on the server. */
export async function reminderState(): Promise<ReminderState> {
  const worker = await registration();
  if (!worker) return 'unsupported';
  const { publicKey } = await getJson<PushConfigResponse>('/push/config');
  if (!publicKey) return 'unavailable';
  if (Notification.permission === 'denied') return 'blocked';
  const subscription = await worker.pushManager.getSubscription();
  if (!subscription) return 'off';
  await register(subscription, savedReminderTime());
  return 'on';
}

/** Asks for permission if needed and subscribes. Returns the resulting state. */
export async function enableReminders(time: string): Promise<ReminderState> {
  const worker = await registration();
  if (!worker) return 'unsupported';
  const { publicKey } = await getJson<PushConfigResponse>('/push/config');
  if (!publicKey) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';
  const subscription = await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  await register(subscription, time);
  return 'on';
}

export async function setReminderTime(time: string) {
  const subscription = await (
    await registration()
  )?.pushManager.getSubscription();
  if (subscription) await register(subscription, time);
}

export async function sendTestReminder() {
  const subscription = await (
    await registration()
  )?.pushManager.getSubscription();
  if (subscription) {
    await postJson('/push/subscription/test', {
      endpoint: subscription.endpoint,
    });
  }
}

/** Stops reminders here. Used on sign-out too, so they don't follow a device. */
export async function disableReminders() {
  const subscription = await (
    await registration()
  )?.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await deleteJson(
    `/push/subscription?endpoint=${encodeURIComponent(endpoint)}`,
  );
}
