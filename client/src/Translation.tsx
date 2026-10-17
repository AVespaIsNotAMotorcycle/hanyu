import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  CRITERIA,
  CRITERION_LABELS,
  MAX_TRANSLATION_LENGTH,
  overallScore,
  paragraphs,
  type AuthUser,
  type GradeTranslationResponse,
  type GradingLimits,
  type Passage,
  type TranslationError,
  type TranslationGrading,
  type TranslationGradingsResponse,
  type WordNote,
} from '@hanyu/shared';
import { getJson, postJson } from './api';

/**
 * Chinese → English translation exercises, one per paragraph, graded by the
 * server (an LLM) against the passage's reference translation.
 */
export function TranslationExercises({
  passage,
  words,
  onUserChange,
}: {
  passage: Passage;
  words: WordNote[];
  onUserChange: (user: AuthUser) => void;
}) {
  const [gradings, setGradings] = useState<TranslationGrading[] | null>(null);
  const [limits, setLimits] = useState<GradingLimits | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<TranslationGradingsResponse>(
      `/translations?passageId=${encodeURIComponent(passage._id)}`,
    )
      .then((response) => {
        setGradings(response.gradings);
        setLimits(response.limits);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [passage._id]);

  if (!passage.translation?.length) return null;
  if (error)
    return <p className="error">Couldn’t load translations: {error}</p>;
  if (!gradings || !limits) return <p className="status">Loading…</p>;

  return (
    <section className="translations">
      <h3>Translate</h3>
      <p className="hint">
        Translate each paragraph into English; it’s graded for accuracy,
        completeness, grammar, and naturalness. Words you misread are added to
        your new cards. {limits.dailyLimit - limits.used} of {limits.dailyLimit}{' '}
        gradings left in the last 24 hours.
      </p>
      {limits.unavailable && <p className="notice">{limits.unavailable}</p>}
      <ol className="translation-list">
        {paragraphs(passage.text).map((source, i) => (
          <li key={i}>
            <Exercise
              passageId={passage._id}
              paragraph={i}
              source={source}
              reference={passage.translation![i] ?? ''}
              latest={gradings.find((g) => g.paragraph === i) ?? null}
              words={words}
              unavailable={limits.unavailable}
              onGraded={({ grading, user, limits }) => {
                setGradings([grading, ...gradings]);
                setLimits(limits);
                onUserChange(user);
              }}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Exercise({
  passageId,
  paragraph,
  source,
  reference,
  latest,
  words,
  unavailable,
  onGraded,
}: {
  passageId: string;
  paragraph: number;
  source: string;
  reference: string;
  latest: TranslationGrading | null;
  words: WordNote[];
  unavailable: string | null;
  onGraded: (response: GradeTranslationResponse) => void;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(!latest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const response = await postJson<GradeTranslationResponse>(
        '/translations',
        { passageId, paragraph, translation: draft },
      );
      onGraded(response);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="exercise">
      <p lang="zh-Hans" className="source">
        {latest && !editing ? (
          <Highlighted
            text={source}
            spans={latest.result.errors.map((e) => [
              e.sourceStart,
              e.sourceSpan,
            ])}
          />
        ) : (
          source
        )}
      </p>
      {editing || !latest ? (
        <form onSubmit={submit}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(8, Math.max(3, Math.ceil(source.length / 25)))}
            maxLength={MAX_TRANSLATION_LENGTH}
            placeholder="Your English translation"
            aria-label={`Translation of paragraph ${paragraph + 1}`}
            disabled={busy}
          />
          <div className="exercise-actions">
            <button
              type="submit"
              disabled={busy || !draft.trim() || unavailable !== null}
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
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <GradingView
          grading={latest}
          reference={reference}
          words={words}
          onRetry={() => {
            setDraft(latest.translation);
            setEditing(true);
          }}
        />
      )}
    </div>
  );
}

/** Text with the quoted spans underlined (overlapping spans merge into the first). */
function Highlighted({
  text,
  spans,
}: {
  text: string;
  spans: [number | null, string][];
}) {
  const ranges = spans
    .flatMap(([start, span]) =>
      start === null ? [] : [[start, start + span.trim().length] as const],
    )
    .sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function GradingView({
  grading,
  reference,
  words,
  onRetry,
}: {
  grading: TranslationGrading;
  reference: string;
  words: WordNote[];
  onRetry: () => void;
}) {
  const { result } = grading;
  const added = grading.addedWords.map(
    (id) => words.find((w) => w._id === id)?.simplified ?? id,
  );
  return (
    <div className="grading">
      <p className="your-translation">
        <Highlighted
          text={grading.translation}
          spans={result.errors.map((e) => [
            e.translationStart,
            e.translationSpan,
          ])}
        />
      </p>
      <p>
        <strong>{overallScore(result)} / 5</strong> {result.summary}
      </p>
      <dl className="scores">
        {CRITERIA.map((c) => (
          <div key={c}>
            <dt>{CRITERION_LABELS[c]}</dt>
            <dd>
              <span className="score">{result.scores[c].score}</span>{' '}
              {result.scores[c].comment}
            </dd>
          </div>
        ))}
      </dl>
      {result.errors.length > 0 && (
        <ul className="translation-errors">
          {result.errors.map((e, i) => (
            <ErrorItem key={i} error={e} />
          ))}
        </ul>
      )}
      {added.length > 0 && (
        <p className="hint">
          Added to your new cards:{' '}
          <span lang="zh-Hans">{added.join('、')}</span>
        </p>
      )}
      <details>
        <summary>Reference translation</summary>
        <p>{reference}</p>
      </details>
      <button type="button" className="link" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function ErrorItem({ error }: { error: TranslationError }) {
  return (
    <li>
      <span className={`badge ${error.severity}`}>{error.severity}</span>{' '}
      <span className="hint">{CRITERION_LABELS[error.criterion]}</span>{' '}
      {error.translationSpan && <q>{error.translationSpan}</q>}
      {error.sourceSpan && (
        <>
          {' '}
          (<span lang="zh-Hans">{error.sourceSpan}</span>)
        </>
      )}
      : {error.explanation}
      {error.suggestion && (
        <>
          {' '}
          <em>Try: {error.suggestion}</em>
        </>
      )}
    </li>
  );
}
