import { useState } from 'react';
import {
  buildDecks,
  buildQueue,
  MAX_DAILY_NEW_CARDS,
  studyDayStart,
  type AuthResponse,
  type AuthUser,
  type HskLevel,
  type StudyMode,
  type UpdateSettingsRequest,
} from '@hanyu/shared';
import { putJson, timeZone } from './api';
import { useStudyData } from './local/LocalData';

/** Per-level decks: which introduce new cards, progress, and the daily limit. */
export function Decks({
  user,
  onUserChange,
  onStudy,
}: {
  user: AuthUser;
  onUserChange: (user: AuthUser) => void;
  onStudy: (mode: StudyMode) => void;
}) {
  const { data, error } = useStudyData(user.settings);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Shown at once while a settings change saves.
  const [pending, setPending] = useState<AuthUser['settings'] | null>(null);
  const settings = pending ?? user.settings;

  async function save(change: UpdateSettingsRequest) {
    setPending({ ...settings, ...change } as AuthUser['settings']);
    try {
      const { user } = await putJson<AuthResponse>('/settings', change);
      onUserChange(user);
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="status">Loading decks…</p>;
  if (!data.dataset) {
    return (
      <p className="error">
        Word lists haven’t been downloaded yet. Connect to the internet once to
        get them.
      </p>
    );
  }

  const now = new Date();
  const decks = buildDecks({
    ...data,
    settings,
    now,
    levelCounts: data.dataset.levelCounts,
  });
  const queue = buildQueue({
    ...data,
    settings,
    now,
    dayStart: studyDayStart(now, timeZone),
  });
  const flagged = decks.reduce((n, d) => n + d.flagged, 0);
  const toggle = (level: HskLevel) =>
    save({
      levels: settings.levels.includes(level)
        ? settings.levels.filter((l) => l !== level)
        : [...settings.levels, level],
    });

  return (
    <section className="decks">
      <div className="study-buttons">
        <button
          type="button"
          className="study"
          onClick={() => onStudy('regular')}
          disabled={queue.cards.length === 0}
        >
          {queue.cards.length === 0
            ? 'All done for today'
            : `Study · ${queue.dueCount} due, ${queue.newCount} new`}
        </button>
        {flagged > 0 && (
          <button
            type="button"
            className="study"
            onClick={() => onStudy('flagged')}
          >
            Study flagged · {flagged}
          </button>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">HSK</th>
            <th scope="col">Started</th>
            <th scope="col">Due</th>
            <th scope="col">Flagged</th>
            <th scope="col">New cards</th>
          </tr>
        </thead>
        <tbody>
          {decks.map((deck) => (
            <tr key={deck.level}>
              <th scope="row">{deck.label}</th>
              <td>
                {deck.started} / {deck.total}
              </td>
              <td>{deck.due || ''}</td>
              <td>{deck.flagged || ''}</td>
              <td>
                <input
                  type="checkbox"
                  checked={deck.enabled}
                  onChange={() => void toggle(deck.level)}
                  aria-label={`Introduce new cards from HSK ${deck.label}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="daily">
        New cards per day{' '}
        <input
          type="number"
          min={0}
          max={MAX_DAILY_NEW_CARDS}
          defaultValue={settings.dailyNewCards}
          key={settings.dailyNewCards}
          onBlur={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isInteger(value) && value !== settings.dailyNewCards) {
              void save({ dailyNewCards: value });
            }
          }}
        />
      </label>
      {saveError && (
        <p className="error" role="alert">
          Couldn’t save: {saveError}
        </p>
      )}
      <p className="hint">
        {queue.introducedToday} new today. New cards come from checked levels,
        most frequent words first; started cards stay in review either way.
        Cards you keep missing are flagged until you get them right three times
        in a row.
      </p>
    </section>
  );
}
