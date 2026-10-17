import { useEffect, useState, type FormEvent } from 'react';
import {
  checkClozeAnswer,
  CLOZE_BLANK,
  HSK_LEVEL_LABELS,
  HSK_LEVELS,
  paragraphs,
  ratingForHandwriting,
  type AuthUser,
  type CharacterContent,
  type ChoiceQuestion,
  type ClozeQuestion,
  type HandwritingResult,
  type HskLevel,
  type PassageResponse,
  type PassagesResponse,
  type PassageSummary,
} from '@hanyu/shared';
import { getJson } from './api';
import { HandwritingQuiz } from './HandwritingQuiz';
import { loadCharacters } from './local/content';
import { useLocalData } from './local/LocalData';

/** Reading passages by level, and the passage being read. */
export function Reading({ user }: { user: AuthUser }) {
  const [level, setLevel] = useState<HskLevel>(user.settings.levels[0] ?? 1);
  const [list, setList] = useState<PassageSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(null);
    getJson<PassagesResponse>(`/passages?level=${level}`)
      .then(({ passages }) => {
        setList(passages);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [level]);

  if (open) {
    return <PassageView id={open} user={user} onBack={() => setOpen(null)} />;
  }
  return (
    <section className="reading">
      <label>
        HSK level{' '}
        <select
          value={level}
          onChange={(event) => setLevel(Number(event.target.value) as HskLevel)}
        >
          {HSK_LEVELS.map((l) => (
            <option key={l} value={l}>
              {HSK_LEVEL_LABELS[l]}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className="error">Couldn’t load passages: {error}</p>
      ) : !list ? (
        <p className="status">Loading passages…</p>
      ) : list.length === 0 ? (
        <p className="hint">No passages at this level yet.</p>
      ) : (
        <ul className="passage-list">
          {list.map((p) => (
            <li key={p._id}>
              <button type="button" onClick={() => setOpen(p._id)}>
                <span lang="zh-Hans" className="title">
                  {p.title}
                </span>
                <span className="hint">
                  {p.titleEnglish} · {p.length} characters · {p.questionCount}{' '}
                  questions
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PassageView({
  id,
  user,
  onBack,
}: {
  id: string;
  user: AuthUser;
  onBack: () => void;
}) {
  const [data, setData] = useState<PassageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [english, setEnglish] = useState(false);

  useEffect(() => {
    getJson<PassageResponse>(`/passages/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((err: unknown) => setError(String(err)));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="status">Loading passage…</p>;
  const { passage, grammarPoints } = data;

  return (
    <article className="passage">
      <p className="session-bar">
        <button type="button" className="link" onClick={onBack}>
          ← Passages
        </button>
        <span>HSK {HSK_LEVEL_LABELS[passage.level]}</span>
      </p>
      <h2 lang="zh-Hans">{passage.title}</h2>
      <p className="hint">{passage.titleEnglish}</p>
      <div className="passage-text" lang="zh-Hans">
        {paragraphs(passage.text).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {grammarPoints.length > 0 && (
        <details className="grammar">
          <summary>Grammar in this passage</summary>
          <ul>
            {grammarPoints.map((g) => (
              <li key={g._id}>
                <strong>{[g.name, g.item].filter(Boolean).join(' · ')}</strong>
                {g.content && <span lang="zh-Hans"> {g.content}</span>}
                {passage.grammar
                  .filter((use) => use.grammarId === g._id)
                  .map((use) => (
                    <q key={use.example} lang="zh-Hans">
                      {use.example}
                    </q>
                  ))}
              </li>
            ))}
          </ul>
        </details>
      )}
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
        {passage.questions.map((q) => (
          <li key={q.id}>
            {q.type === 'choice' ? (
              <Choice question={q} english={english} />
            ) : (
              <Cloze question={q} user={user} />
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}

function Choice({
  question,
  english,
}: {
  question: ChoiceQuestion;
  english: boolean;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="question">
      <p lang="zh-Hans">{question.prompt}</p>
      {english && <p className="hint">{question.promptEnglish}</p>}
      <div className="options">
        {question.options.map((option, i) => (
          <button
            key={i}
            type="button"
            lang="zh-Hans"
            disabled={picked !== null}
            className={
              picked === null
                ? undefined
                : i === question.answer
                  ? 'right'
                  : i === picked
                    ? 'wrong'
                    : undefined
            }
            onClick={() => setPicked(i)}
          >
            {option}
          </button>
        ))}
      </div>
      {picked !== null && (
        <p
          className={`feedback ${picked === question.answer ? 'correct' : 'wrong'}`}
        >
          <strong>
            {picked === question.answer ? 'Correct.' : 'Not quite.'}
          </strong>{' '}
          {question.explanation}
        </p>
      )}
    </div>
  );
}

type Mode = 'keyboard' | 'handwriting';
const MODE_KEY = 'hanyu.clozeMode';

function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'handwriting'
      ? 'handwriting'
      : 'keyboard';
  } catch {
    return 'keyboard';
  }
}

/**
 * A fill-in-the-blank question, answered by typing (any IME) or by writing
 * each character of the answer. The mode switches per question; the last
 * choice becomes the default for the next.
 */
function Cloze({
  question,
  user,
}: {
  question: ClozeQuestion;
  user: AuthUser;
}) {
  const [mode, setMode] = useState<Mode>(savedMode);
  const [result, setResult] = useState<{
    correct: boolean;
    typed?: string;
  } | null>(null);
  const [before, after] = question.sentence.split(CLOZE_BLANK) as [
    string,
    string,
  ];

  function switchTo(next: Mode) {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Only the default for the next question is lost.
    }
  }

  return (
    <div className="question">
      <p lang="zh-Hans" className="cloze-sentence">
        {before}
        <span
          className={`blank ${result ? (result.correct ? 'right' : 'wrong') : ''}`}
        >
          {result ? question.answer : CLOZE_BLANK}
        </span>
        {after}
      </p>
      <p className="hint">Hint: {question.hint}</p>
      {!result && (
        <div className="mode-switch" role="group" aria-label="Answer by">
          <button
            type="button"
            aria-pressed={mode === 'keyboard'}
            onClick={() => switchTo('keyboard')}
          >
            ⌨ Type
          </button>
          <button
            type="button"
            aria-pressed={mode === 'handwriting'}
            onClick={() => switchTo('handwriting')}
          >
            ✍ Write
          </button>
        </div>
      )}
      {result ? (
        <p className={`feedback ${result.correct ? 'correct' : 'wrong'}`}>
          <strong>{result.correct ? 'Correct.' : 'Not quite.'}</strong>{' '}
          {result.typed !== undefined && !result.correct && (
            <>You wrote {result.typed || '(nothing)'}. </>
          )}
          The answer is <span lang="zh-Hans">{question.answer}</span>
          {question.alsoAccepted.length > 0 && (
            <>
              {' '}
              (also:{' '}
              <span lang="zh-Hans">{question.alsoAccepted.join('、')}</span>)
            </>
          )}
          .
        </p>
      ) : mode === 'keyboard' ? (
        <ClozeKeyboard
          question={question}
          onAnswer={(typed) =>
            setResult({ correct: checkClozeAnswer(typed, question), typed })
          }
        />
      ) : (
        <ClozeHandwriting
          answer={question.answer}
          user={user}
          onAnswer={(correct) => setResult({ correct })}
        />
      )}
    </div>
  );
}

function ClozeKeyboard({
  question,
  onAnswer,
}: {
  question: ClozeQuestion;
  onAnswer: (typed: string) => void;
}) {
  const [typed, setTyped] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (typed.trim()) onAnswer(typed);
  }
  return (
    <form className="cloze-keyboard" onSubmit={submit}>
      <input
        lang="zh-Hans"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        aria-label={`Missing word (${question.hint})`}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit">Check</button>
    </form>
  );
}

/**
 * Write the answer one character at a time. It counts as correct when every
 * character would pass as a handwriting review under the user's settings.
 */
function ClozeHandwriting({
  answer,
  user,
  onAnswer,
}: {
  answer: string;
  user: AuthUser;
  onAnswer: (correct: boolean) => void;
}) {
  const { store } = useLocalData();
  const chars = [...answer];
  const [characters, setCharacters] = useState<Map<
    string,
    CharacterContent
  > | null>(null);
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<HandwritingResult[]>([]);

  useEffect(() => {
    void loadCharacters(store, chars).then(setCharacters);
  }, [store, answer]);

  if (!characters) return <p className="status">Loading stroke data…</p>;
  const missing = chars.filter((c) => !characters.has(c));
  if (missing.length) {
    return (
      <p className="error">
        No stroke data for {missing.join('')} (offline?). Type the answer
        instead.
      </p>
    );
  }

  function done(result: HandwritingResult) {
    const all = [...results, result];
    setResults(all);
    if (all.length < chars.length) {
      setTimeout(() => setIndex(all.length), 600);
    } else {
      onAnswer(
        all.every(
          (r) => ratingForHandwriting(r, user.settings.handwriting) >= 2,
        ),
      );
    }
  }

  return (
    <div className="cloze-handwriting">
      {chars.length > 1 && (
        <p className="hint">
          Character {index + 1} of {chars.length}
        </p>
      )}
      <HandwritingQuiz
        key={index}
        character={characters.get(chars[index]!)!}
        onDone={done}
      />
    </div>
  );
}
