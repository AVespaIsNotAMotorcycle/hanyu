import { useEffect, useState } from 'react';
import {
  audioKeys,
  HSK_LEVEL_LABELS,
  HSK_LEVELS,
  type AuthUser,
  type HskLevel,
  type ListeningListResponse,
  type ListeningResponse,
  type ListeningSummary,
} from '@hanyu/shared';
import { getJson } from './api';
import { Question } from './Reading';
import { SpeakButton, SpeakSlowlyToggle } from './Speak';

const done = (e: ListeningSummary) => e.progress.correct === e.questionCount;

/** Listening exercises by level, and the one being done. */
export function Listening({ user }: { user: AuthUser }) {
  const [level, setLevel] = useState<HskLevel>(user.settings.levels[0] ?? 1);
  const [all, setAll] = useState<ListeningSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reloaded on returning from an exercise, for its question progress.
  useEffect(() => {
    if (open) return;
    getJson<ListeningListResponse>('/listening')
      .then(({ exercises }) => {
        setAll(exercises);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [open]);

  const list = (all ?? []).filter((e) => e.level === level);
  // The next one at this level not yet answered all right, after `from`.
  const nextAfter = (from: string | null) => {
    const start = from ? list.findIndex((e) => e._id === from) + 1 : 0;
    return [...list.slice(start), ...list.slice(0, start)].find(
      (e) => e._id !== from && !done(e),
    );
  };

  if (open) {
    const next = nextAfter(open);
    return (
      <ListeningView
        key={open}
        id={open}
        user={user}
        onNext={next ? () => setOpen(next._id) : null}
        onBack={() => setOpen(null)}
      />
    );
  }
  if (error) return <p className="error">Couldn’t load exercises: {error}</p>;
  if (!all) return <p className="status">Loading exercises…</p>;

  const next = nextAfter(null);
  return (
    <section className="reading">
      <p className="hint">
        Listen to a few sentences, as many times as you like, and answer
        questions about them. The text stays hidden until you’ve answered.
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
        <p className="hint">No listening exercises at this level yet.</p>
      ) : (
        <>
          {next && (
            <p>
              <button type="button" onClick={() => setOpen(next._id)}>
                {list.some((e) => e.progress.answered > 0)
                  ? 'Continue'
                  : 'Start'}{' '}
                listening
              </button>
            </p>
          )}
          <ul className="passage-list">
            {list.map((exercise, i) => (
              <li key={exercise._id}>
                <button type="button" onClick={() => setOpen(exercise._id)}>
                  <span className="title">
                    Exercise {i + 1}
                    {done(exercise) && (
                      <span className="read" aria-label="all answered right">
                        {' '}
                        ✓
                      </span>
                    )}
                  </span>
                  <span className="hint">
                    {exercise.questionCount}{' '}
                    {exercise.questionCount === 1 ? 'question' : 'questions'}
                    {exercise.progress.answered > 0 &&
                      !done(exercise) &&
                      ` · ${exercise.progress.correct} of ${exercise.questionCount} answered right`}
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

function ListeningView({
  id,
  user,
  onNext,
  onBack,
}: {
  id: string;
  user: AuthUser;
  onNext: (() => void) | null;
  onBack: () => void;
}) {
  const [data, setData] = useState<ListeningResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [english, setEnglish] = useState(false);

  useEffect(() => {
    getJson<ListeningResponse>(`/listening/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((err: unknown) => setError(String(err)));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="status">Loading exercise…</p>;
  const { exercise } = data;
  // The transcript would give the answers away, so it waits until every
  // question has been answered at least once.
  const answeredAll = exercise.questions.every((q) =>
    data.progress.some((p) => p.questionId === q.id),
  );

  return (
    <article className="passage listening">
      <p className="session-bar">
        <button type="button" className="link" onClick={onBack}>
          ← Listening
        </button>
        <span>HSK {HSK_LEVEL_LABELS[exercise.level]}</span>
      </p>
      <p className="speak-bar listen-bar">
        <SpeakButton
          text={exercise.text}
          clip={audioKeys.listening(exercise._id)}
          label="Play"
          showLabel
        />
        <SpeakSlowlyToggle />
      </p>
      <p className="hint">Play it as many times as you need.</p>
      <h3>Questions</h3>
      <label className="hint">
        <input
          type="checkbox"
          checked={english}
          onChange={(event) => setEnglish(event.target.checked)}
        />{' '}
        Show questions in English
      </label>
      <ol className="questions">
        {exercise.questions.map((q) => (
          <li key={q.id}>
            <Question
              answersPath={`/listening/${encodeURIComponent(exercise._id)}/answers`}
              clip={audioKeys.listeningPrompt(exercise._id, q.id)}
              question={q}
              english={english}
              user={user}
              progress={
                data.progress.find((p) => p.questionId === q.id) ?? null
              }
              onProgress={(progress) =>
                setData(
                  (current) =>
                    current && {
                      ...current,
                      progress: [
                        ...current.progress.filter(
                          (p) => p.questionId !== q.id,
                        ),
                        progress,
                      ],
                    },
                )
              }
            />
          </li>
        ))}
      </ol>
      {answeredAll && (
        <details className="transcript">
          <summary>Transcript</summary>
          <p lang="zh-Hans" className="passage-text">
            {exercise.text}
          </p>
          <p className="hint">{exercise.textEnglish}</p>
        </details>
      )}
      {onNext && (
        <p>
          <button type="button" onClick={onNext}>
            Next exercise →
          </button>
        </p>
      )}
    </article>
  );
}
