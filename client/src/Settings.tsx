import { useState } from 'react';
import {
  HSK_LEVEL_LABELS,
  HSK_LEVELS,
  MAX_ALLOWED_MISSES,
  MAX_DAILY_NEW_CARDS,
  pendingAddedWords,
  type AuthResponse,
  type AuthUser,
  type HskLevel,
  type UpdateSettingsRequest,
} from '@hanyu/shared';
import { putJson } from './api';
import { useStudyData } from './local/LocalData';
import { SpeechSettings } from './Speak';

/** What to study and how: levels, the daily limit, handwriting, read-aloud. */
export function Settings({
  user,
  onUserChange,
  onSignOut,
}: {
  user: AuthUser;
  onUserChange: (user: AuthUser) => void;
  onSignOut: () => void;
}) {
  const { data } = useStudyData(user.settings);
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

  const added = data ? pendingAddedWords(settings, data.summaries).length : 0;
  const toggle = (level: HskLevel) =>
    save({
      levels: settings.levels.includes(level)
        ? settings.levels.filter((l) => l !== level)
        : [...settings.levels, level],
    });

  return (
    <section className="settings">
      <h2>Settings</h2>
      <fieldset>
        <legend>New words</legend>
        <div className="level-picker" role="group" aria-label="HSK levels">
          {HSK_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={settings.levels.includes(level)}
              aria-label={`Introduce new cards from HSK ${HSK_LEVEL_LABELS[level]}`}
              onClick={() => void toggle(level)}
            >
              HSK {HSK_LEVEL_LABELS[level]}
            </button>
          ))}
        </div>
        <label className="inline">
          New cards per day
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
        <p className="hint">
          New cards come from the selected levels, most frequent words first
          {added > 0 &&
            `, after the ${added} ${added === 1 ? 'word' : 'words'} you added while reading`}
          . Started cards stay in review either way.
        </p>
      </fieldset>
      <fieldset>
        <legend>Handwriting</legend>
        <label className="check-row">
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
            <label className="inline">
              Stroke order
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
            <label className="inline">
              Misses allowed for a pass
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
      <fieldset>
        <legend>Account</legend>
        <p className="account">
          <span>{user.displayName ?? user.email}</span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      </fieldset>
    </section>
  );
}
