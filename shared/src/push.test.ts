import { describe, expect, it } from 'vitest';
import {
  isPushEndpoint,
  isPushKeys,
  isReminderTime,
  localClock,
  reminderDue,
} from './push.js';

describe('isPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://db5p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (url) => expect(isPushEndpoint(url)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://localhost/abc',
    'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com.evil.example/abc',
    'https://evil.example/?https://fcm.googleapis.com',
    'https://fcm.googleapis.com:8443/abc',
    'https://user@fcm.googleapis.com/abc',
    'not a url',
    42,
  ])('rejects %s', (url) => expect(isPushEndpoint(url)).toBe(false));
});

describe('validators', () => {
  it('checks reminder times', () => {
    expect(isReminderTime('00:00')).toBe(true);
    expect(isReminderTime('23:59')).toBe(true);
    expect(isReminderTime('24:00')).toBe(false);
    expect(isReminderTime('7:30')).toBe(false);
  });

  it('checks push keys', () => {
    expect(isPushKeys({ p256dh: 'abc-_', auth: 'def=' })).toBe(true);
    expect(isPushKeys({ p256dh: 'abc' })).toBe(false);
    expect(isPushKeys({ p256dh: 'a b', auth: 'c' })).toBe(false);
    expect(isPushKeys(null)).toBe(false);
  });
});

describe('localClock', () => {
  it('reads the time zone, across a date line', () => {
    const now = new Date('2026-03-10T03:30:00Z');
    expect(localClock(now, 'UTC')).toEqual({
      date: '2026-03-10',
      minutes: 210,
    });
    expect(localClock(now, 'America/New_York')).toEqual({
      date: '2026-03-09',
      minutes: 23 * 60 + 30,
    });
    expect(localClock(now, 'Asia/Shanghai').minutes).toBe(11 * 60 + 30);
  });

  it('calls midnight 0, not 24', () => {
    expect(localClock(new Date('2026-03-10T00:00:00Z'), 'UTC').minutes).toBe(0);
  });
});

describe('reminderDue', () => {
  const at = (time: string) => new Date(`2026-03-10T${time}:00Z`);
  const subscription = {
    time: '19:00',
    timeZone: 'UTC',
    lastSentOn: null as string | null,
  };

  it('fires from the set time, for an hour', () => {
    expect(reminderDue(subscription, at('18:59'))).toBeNull();
    expect(reminderDue(subscription, at('19:00'))).toBe('2026-03-10');
    expect(reminderDue(subscription, at('19:59'))).toBe('2026-03-10');
    expect(reminderDue(subscription, at('20:00'))).toBeNull();
  });

  it('fires once a day', () => {
    const sent = { ...subscription, lastSentOn: '2026-03-10' };
    expect(reminderDue(sent, at('19:30'))).toBeNull();
    expect(
      reminderDue({ ...subscription, lastSentOn: '2026-03-09' }, at('19:30')),
    ).toBe('2026-03-10');
  });

  it('uses the local time', () => {
    const newYork = { ...subscription, timeZone: 'America/New_York' };
    // 7 p.m. in New York during daylight saving time.
    expect(reminderDue(newYork, new Date('2026-07-10T23:00:00Z'))).toBe(
      '2026-07-10',
    );
    expect(reminderDue(newYork, at('19:00'))).toBeNull();
  });
});
