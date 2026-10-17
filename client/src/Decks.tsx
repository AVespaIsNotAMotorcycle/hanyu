import { useEffect, useState } from 'react';
import {
  MAX_DAILY_NEW_CARDS,
  newCardAllowance,
  type AuthResponse,
  type AuthUser,
  type DecksResponse,
  type HskLevel,
  type UpdateSettingsRequest,
} from '@hanyu/shared';
import { getJson, putJson, timeZone } from './api';

/** Per-level decks: which introduce new cards, progress, and the daily limit. */
export function Decks({
  onUserChange,
  onStudy,
}: {
  onUserChange: (user: AuthUser) => void;
  onStudy: () => void;
}) {
  const [data, setData] = useState<DecksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function load() {
    try {
      setData(
        await getJson<DecksResponse>(
          `/decks?tz=${encodeURIComponent(timeZone)}`,
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(settings: UpdateSettingsRequest) {
    try {
      const { user } = await putJson<AuthResponse>('/settings', settings);
      onUserChange(user);
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
    await load();
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="status">Loading decks…</p>;

  const enabled = data.decks.filter((d) => d.enabled).map((d) => d.level);
  const toggle = (level: HskLevel) => {
    // Show the change at once; load() afterwards corrects it if saving fails.
    setData({
      ...data,
      decks: data.decks.map((d) =>
        d.level === level ? { ...d, enabled: !d.enabled } : d,
      ),
    });
    return save({
      levels: enabled.includes(level)
        ? enabled.filter((l) => l !== level)
        : [...enabled, level],
    });
  };
  const due = data.decks.reduce((n, d) => n + d.due, 0);
  const unstarted = data.decks
    .filter((d) => d.enabled)
    .reduce((n, d) => n + d.total - d.started, 0);
  const newToday = Math.min(
    unstarted,
    newCardAllowance(data.dailyNewCards, data.introducedToday),
  );

  return (
    <section className="decks">
      <button
        type="button"
        className="study"
        onClick={onStudy}
        disabled={due + newToday === 0}
      >
        {due + newToday === 0
          ? 'All done for today'
          : `Study · ${due} due, ${newToday} new`}
      </button>
      <table>
        <thead>
          <tr>
            <th scope="col">HSK</th>
            <th scope="col">Started</th>
            <th scope="col">Due</th>
            <th scope="col">New cards</th>
          </tr>
        </thead>
        <tbody>
          {data.decks.map((deck) => (
            <tr key={deck.level}>
              <th scope="row">{deck.label}</th>
              <td>
                {deck.started} / {deck.total}
              </td>
              <td>{deck.due || ''}</td>
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
          defaultValue={data.dailyNewCards}
          key={data.dailyNewCards}
          onBlur={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isInteger(value) && value !== data.dailyNewCards) {
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
        {data.introducedToday} new today. New cards come from checked levels,
        most frequent words first; started cards stay in review either way.
      </p>
    </section>
  );
}
