import { useEffect, useState } from 'react';
import {
  disableReminders,
  enableReminders,
  reminderState,
  savedReminderTime,
  sendTestReminder,
  setReminderTime,
  type ReminderState,
} from './local/push';

const NOTES: Partial<Record<ReminderState, string>> = {
  unsupported:
    'This browser can’t show reminders. On iPhone or iPad, add Hanyu to your Home Screen and open it from there.',
  unavailable: 'Reminders aren’t set up on the server yet.',
  blocked:
    'Notifications are blocked for this site. Allow them in your browser’s site settings, then reload.',
};

/** A daily reminder to practice, set per device. */
export function ReminderSettings() {
  const [state, setState] = useState<ReminderState | null>(null);
  const [time, setTime] = useState(savedReminderTime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    reminderState()
      .then(setState)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const on = state === 'on';
  const canChoose = on || state === 'off';
  return (
    <fieldset>
      <legend>Daily reminder</legend>
      {state === null && !error && <p className="hint">Checking…</p>}
      {canChoose && (
        <>
          <label className="check-row">
            <input
              type="checkbox"
              checked={on}
              disabled={busy}
              onChange={(event) => {
                const enable = event.target.checked;
                void run(async () => {
                  if (enable) setState(await enableReminders(time));
                  else {
                    await disableReminders();
                    setState('off');
                  }
                });
              }}
            />{' '}
            Remind me to practice on this device
          </label>
          <label className="inline">
            Remind me at
            <input
              type="time"
              value={time}
              required
              onChange={(event) => {
                const next = event.target.value;
                if (!next) return;
                setTime(next);
                if (on) void run(() => setReminderTime(next));
              }}
            />
          </label>
        </>
      )}
      {on && (
        <p className="speak-bar">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await sendTestReminder();
                setTested(true);
              })
            }
          >
            Send a test
          </button>
          {tested && <span className="hint">Sent.</span>}
        </p>
      )}
      {state && NOTES[state] && <p className="hint">{NOTES[state]}</p>}
      {canChoose && (
        <p className="hint">
          Only sent if you haven’t practiced yet that day. Set this on each
          device you want reminded on.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
