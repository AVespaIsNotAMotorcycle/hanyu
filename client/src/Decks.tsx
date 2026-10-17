import { useState } from 'react';
import {
  buildDecks,
  buildQueue,
  MAX_ALLOWED_MISSES,
  MAX_DAILY_NEW_CARDS,
  pendingAddedWords,
  studyDayStart,
  type AuthResponse,
  type AuthUser,
  type HskLevel,
  type StudyMode,
  type UpdateSettingsRequest,
} from '@hanyu/shared';
import { putJson, timeZone } from './api';
import { useStudyData } from './local/LocalData';
import { SpeechSettings } from './Speak';

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
    setPending({
      ...settings,
      ...change,
      handwriting: { ...settings.handwriting, ...change.handwriting },
    } as AuthUser['settings']);
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
    dataset: data.dataset,
    settings,
    now,
  });
  const queue = buildQueue({
    ...data,
    settings,
    now,
    dayStart: studyDayStart(now, timeZone),
  });
  const flagged = decks.reduce((n, d) => n + d.flagged, 0);
  const added = pendingAddedWords(settings, data.summaries).length;
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
      <fieldset className="handwriting-settings">
        <legend>Handwriting</legend>
        <label>
          <input
            type="checkbox"
            checked={settings.handwriting.enabled}
            onChange={(event) =>
              void save({ handwriting: { enabled: event.target.checked } })
            }
          />{' '}
          Write characters from words you’ve started
        </label>
        {settings.handwriting.enabled && (
          <>
            <label>
              Stroke order{' '}
              <select
                value={settings.handwriting.strokeOrder}
                onChange={(event) =>
                  void save({
                    handwriting: {
                      strokeOrder: event.target.value as 'strict' | 'lenient',
                    },
                  })
                }
              >
                <option value="strict">Strict: out of order is a miss</option>
                <option value="lenient">
                  Lenient: out of order is forgiven
                </option>
              </select>
            </label>
            <label>
              Misses allowed for a pass{' '}
              <input
                type="number"
                min={0}
                max={MAX_ALLOWED_MISSES}
                defaultValue={settings.handwriting.allowedMisses}
                key={settings.handwriting.allowedMisses}
                onBlur={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (
                    Number.isInteger(value) &&
                    value !== settings.handwriting.allowedMisses
                  ) {
                    void save({ handwriting: { allowedMisses: value } });
                  }
                }}
              />
            </label>
            <p className="hint">
              A clean character is Good; up to the allowed misses, Hard; more,
              or a hint, Again.
            </p>
          </>
        )}
      </fieldset>
      <SpeechSettings />
      {saveError && (
        <p className="error" role="alert">
          Couldn’t save: {saveError}
        </p>
      )}
      <p className="hint">
        {queue.introducedToday} new today. New cards come from checked levels,
        most frequent words first
        {added > 0 &&
          `, after the ${added} ${added === 1 ? 'word' : 'words'} you added while reading`}
        ; started cards stay in review either way. Cards you keep missing are
        flagged until you get them right three times in a row.
      </p>
    </section>
  );
}
