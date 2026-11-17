import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  HSK_LEVEL_LABELS,
  HSK_LEVELS,
  MAX_TRANSLATION_LENGTH,
  type AuthUser,
  type GradeTranslationResponse,
  type HskLevel,
  type TranslateListResponse,
  type TranslateResponse,
  type TranslateSummary,
} from '@hanyu/shared';
import { getJson, postJson } from './api';
import { useStudyData } from './local/LocalData';
import { navigate, navigateUp } from './route';
import { GradingView, Highlighted } from './Translation';

const done = (e: TranslateSummary) => e.progress.gradings > 0;

/** English → Chinese translation exercises by level, and the one being done. */
export function Translate({
  user,
  exercise: open,
  onUserChange,
}: {
  user: AuthUser;
  /** The exercise being done, from the URL. */
  exercise: string | null;
  onUserChange: (user: AuthUser) => void;
}) {
  const [level, setLevel] = useState<HskLevel>(user.settings.levels[0] ?? 1);
  const [all, setAll] = useState<TranslateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reloaded on returning from an exercise, for its progress.
  useEffect(() => {
    if (open) return;
    getJson<TranslateListResponse>('/translate')
      .then(({ exercises }) => {
        setAll(exercises);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [open]);

  const list = (all ?? []).filter((e) => e.level === level);
  // The next one at this level not yet graded, after `from`.
  const nextAfter = (from: string | null) => {
    const start = from ? list.findIndex((e) => e._id === from) + 1 : 0;
    return [...list.slice(start), ...list.slice(0, start)].find(
      (e) => e._id !== from && !done(e),
    );
  };

  if (open) {
    const next = nextAfter(open);
    return (
      <TranslateView
        key={open}
        id={open}
        user={user}
        onUserChange={onUserChange}
        onNext={
          next
            ? () =>
                navigate(
                  { name: 'translate', exercise: next._id },
                  { replace: true },
                )
            : null
        }
        onBack={() => navigateUp({ name: 'translate' })}
      />
    );
  }
  if (error) return <p className="error">Couldn’t load exercises: {error}</p>;
  if (!all) return <p className="status">Loading exercises…</p>;

  const next = nextAfter(null);
  return (
    <section className="reading">
      <p className="hint">
        Translate a few English sentences into Chinese. Your translation is
        graded for accuracy, completeness, grammar, and naturalness, and words
        you didn’t know are added to your new cards.
      </p>
      <h2>
        <label>
          Level{' '}
          <select
            value={level}
            onChange={(event) =>
              setLevel(Number(event.target.value) as HskLevel)
            }
          >
            {HSK_LEVELS.map((l) => (
              <option key={l} value={l}>
                HSK {HSK_LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
      </h2>
      {list.length === 0 ? (
        <p className="hint">No translation exercises at this level yet.</p>
      ) : (
        <>
          {next && (
            <p>
              <button
                type="button"
                onClick={() =>
                  navigate({ name: 'translate', exercise: next._id })
                }
              >
                {list.some(done) ? 'Continue' : 'Start'} translating
              </button>
            </p>
          )}
          <ul className="passage-list">
            {list.map((exercise) => (
              <li key={exercise._id}>
                <button
                  type="button"
                  onClick={() =>
                    navigate({ name: 'translate', exercise: exercise._id })
                  }
                >
                  <span className="title">
                    {exercise.topic}
                    {done(exercise) && (
                      <span className="read" aria-label="graded">
                        {' '}
                        ✓
                      </span>
                    )}
                  </span>
                  <span className="hint">
                    {exercise.progress.best === null
                      ? 'Not translated yet'
                      : `Best ${exercise.progress.best} / 5`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function TranslateView({
  id,
  user,
  onUserChange,
  onNext,
  onBack,
}: {
  id: string;
  user: AuthUser;
  onUserChange: (user: AuthUser) => void;
  onNext: (() => void) | null;
  onBack: () => void;
}) {
  const [data, setData] = useState<TranslateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);
  // For showing the words a grading added to the SRS.
  const { data: study } = useStudyData(user.settings);
  const words = useMemo(() => [...(study?.words.values() ?? [])], [study]);

  useEffect(() => {
    getJson<TranslateResponse>(`/translate/${encodeURIComponent(id)}`)
      .then((response) => {
        setData(response);
        setEditing(response.gradings.length === 0);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="status">Loading exercise…</p>;
  const { exercise, gradings, limits } = data;
  const latest = gradings[0] ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const response = await postJson<GradeTranslationResponse>(
        `/translate/${encodeURIComponent(id)}/gradings`,
        { translation: draft },
      );
      setData(
        (current) =>
          current && {
            ...current,
            gradings: [response.grading, ...current.gradings],
            limits: response.limits,
          },
      );
      onUserChange(response.user);
      setEditing(false);
      setGradeError(null);
    } catch (err) {
      setGradeError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="passage translate">
      <p className="session-bar">
        <button type="button" className="link" onClick={onBack}>
          ← Translate
        </button>
        <span>HSK {HSK_LEVEL_LABELS[exercise.level]}</span>
      </p>
      <h2>{exercise.topic}</h2>
      <div className="exercise">
        <p lang="en" className="source">
          {latest && !editing ? (
            <Highlighted
              text={exercise.english}
              spans={latest.result.errors.map((e) => [
                e.sourceStart,
                e.sourceSpan,
              ])}
            />
          ) : (
            exercise.english
          )}
        </p>
        {editing || !latest ? (
          <form onSubmit={submit}>
            <textarea
              lang="zh-Hans"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={Math.min(
                8,
                Math.max(3, Math.ceil(exercise.english.length / 60)),
              )}
              maxLength={MAX_TRANSLATION_LENGTH}
              placeholder="Your Chinese translation"
              aria-label="Your Chinese translation"
              disabled={busy}
            />
            <p className="hint">
              {limits.dailyLimit - limits.used} of {limits.dailyLimit} gradings
              left in the last 24 hours.
            </p>
            {limits.unavailable && (
              <p className="notice">{limits.unavailable}</p>
            )}
            <div className="exercise-actions">
              <button
                type="submit"
                disabled={busy || !draft.trim() || limits.unavailable !== null}
              >
                {busy ? 'Grading…' : 'Grade'}
              </button>
              {latest && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setEditing(false)}
                >
                  Back to last grading
                </button>
              )}
            </div>
            {gradeError && (
              <p className="error" role="alert">
                {gradeError}
              </p>
            )}
          </form>
        ) : (
          <GradingView
            grading={latest}
            words={words}
            onRetry={() => {
              setDraft(latest.translation);
              setEditing(true);
            }}
          />
        )}
      </div>
      {onNext && latest && !editing && (
        <p>
          <button type="button" onClick={onNext}>
            Next exercise →
          </button>
        </p>
      )}
    </article>
  );
}
