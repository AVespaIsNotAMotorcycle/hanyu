import { useEffect, useState, type FormEvent } from 'react';
import {
  cardKey,
  checkClozeAnswer,
  CLOZE_BLANK,
  displayPinyin,
  HSK_LEVEL_LABELS,
  HSK_LEVELS,
  isHanziToken,
  paragraphs,
  passageFamiliarity,
  pendingAddedWords,
  ratingForHandwriting,
  recommendPassages,
  type AuthResponse,
  type AuthUser,
  type CardSummary,
  type CharacterContent,
  type ChoiceQuestion,
  type ClozeQuestion,
  type Familiarity,
  type HandwritingResult,
  type HskLevel,
  type PassageResponse,
  type PassagesResponse,
  type PassageSummary,
  type WordNote,
} from '@hanyu/shared';
import { deleteJson, getJson, postJson } from './api';
import { formatInterval } from './format';
import { HandwritingQuiz } from './HandwritingQuiz';
import { loadCharacters } from './local/content';
import { useLocalData, useStudyData } from './local/LocalData';
import type { LocalStore } from './local/store';
import { TranslationExercises } from './Translation';

// Passages opened on this device. Only recommendations use it, so it isn't
// synced; it goes with the local database on sign-out.
const READ = 'readPassages';

async function readPassageIds(store: LocalStore): Promise<Set<string>> {
  return new Set((await store.getMeta<string[]>(READ)) ?? []);
}

async function markRead(store: LocalStore, id: string) {
  const read = await readPassageIds(store);
  if (!read.has(id)) await store.setMeta(READ, [...read, id]);
}

const NO_CARDS: ReadonlyMap<string, CardSummary> = new Map();

/** Recommended passages, then passages by level, and the passage being read. */
export function Reading({
  user,
  onUserChange,
}: {
  user: AuthUser;
  onUserChange: (user: AuthUser) => void;
}) {
  const { store } = useLocalData();
  // Cards, for how familiar each passage is; passages show without them.
  const { data } = useStudyData(user.settings);
  const summaries = data?.summaries ?? NO_CARDS;
  const [level, setLevel] = useState<HskLevel>(user.settings.levels[0] ?? 1);
  const [all, setAll] = useState<PassageSummary[] | null>(null);
  const [read, setRead] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<PassagesResponse>('/passages')
      .then(({ passages }) => {
        setAll(passages);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);

  // Reloaded on returning from a passage, which marks it read.
  useEffect(() => {
    if (!open) void readPassageIds(store).then(setRead);
  }, [store, open]);

  if (open) {
    return (
      <PassageView
        id={open}
        user={user}
        summaries={summaries}
        onUserChange={onUserChange}
        onBack={() => setOpen(null)}
      />
    );
  }
  if (error) return <p className="error">Couldn’t load passages: {error}</p>;
  if (!all) return <p className="status">Loading passages…</p>;

  const recommended = data ? recommendPassages(all, summaries, read) : [];
  const list = all.filter((p) => p.level === level);
  const item = (passage: PassageSummary) => (
    <li key={passage._id}>
      <PassageItem
        passage={passage}
        familiarity={
          data ? passageFamiliarity(passage.vocabulary, summaries) : null
        }
        read={read.has(passage._id)}
        onOpen={() => setOpen(passage._id)}
      />
    </li>
  );

  return (
    <section className="reading">
      {recommended.length > 0 && (
        <>
          <h2>Recommended</h2>
          <p className="hint">
            Passages made mostly of words you’re reviewing, unread first.
          </p>
          <ul className="passage-list">
            {recommended.map(({ passage }) => item(passage))}
          </ul>
        </>
      )}
      <h2>
        <label>
          By level{' '}
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
        <p className="hint">No passages at this level yet.</p>
      ) : (
        <ul className="passage-list">{list.map(item)}</ul>
      )}
    </section>
  );
}

const percent = (n: number, total: number) =>
  `${Math.round((n / total) * 100)}%`;

function PassageItem({
  passage,
  familiarity,
  read,
  onOpen,
}: {
  passage: PassageSummary;
  familiarity: Familiarity | null;
  read: boolean;
  onOpen: () => void;
}) {
  const known = familiarity?.total
    ? [
        `${percent(familiarity.known, familiarity.total)} of words known`,
        familiarity.learning
          ? `${percent(familiarity.learning, familiarity.total)} learning`
          : null,
      ]
        .filter(Boolean)
        .join(', ')
    : null;
  return (
    <button type="button" onClick={onOpen}>
      <span lang="zh-Hans" className="title">
        {passage.title}
        {read && (
          <span className="read" aria-label="read">
            {' '}
            ✓
          </span>
        )}
      </span>
      <span className="hint">
        HSK {HSK_LEVEL_LABELS[passage.level]} · {passage.titleEnglish} ·{' '}
        {passage.length} characters · {passage.questionCount} questions
        {passage.translatable && ' · translation'}
      </span>
      {known && <span className="hint">{known}</span>}
    </button>
  );
}

function PassageView({
  id,
  user,
  summaries,
  onUserChange,
  onBack,
}: {
  id: string;
  user: AuthUser;
  summaries: ReadonlyMap<string, CardSummary>;
  onUserChange: (user: AuthUser) => void;
  onBack: () => void;
}) {
  const { store } = useLocalData();
  const [data, setData] = useState<PassageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [english, setEnglish] = useState(false);
  // The tapped token, by paragraph and position.
  const [selected, setSelected] = useState<{
    text: string;
    at: string;
  } | null>(null);

  useEffect(() => {
    getJson<PassageResponse>(`/passages/${encodeURIComponent(id)}`)
      .then((response) => {
        setData(response);
        void markRead(store, id);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [id, store]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="status">Loading passage…</p>;
  const { passage, grammarPoints, words } = data;

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
        {passage.tokens?.length
          ? passage.tokens.map((tokens, i) => (
              <p key={i}>
                {tokens.map((token, j) =>
                  isHanziToken(token) ? (
                    <button
                      key={j}
                      type="button"
                      className="token"
                      aria-pressed={selected?.at === `${i}:${j}`}
                      onClick={() =>
                        setSelected(
                          selected?.at === `${i}:${j}`
                            ? null
                            : { text: token, at: `${i}:${j}` },
                        )
                      }
                    >
                      {token}
                    </button>
                  ) : (
                    <span key={j}>{token}</span>
                  ),
                )}
              </p>
            ))
          : paragraphs(passage.text).map((p, i) => <p key={i}>{p}</p>)}
      </div>
      {passage.tokens?.length ? (
        <p className="hint">Tap a word to look it up.</p>
      ) : null}
      {selected && (
        <WordLookup
          key={selected.at}
          token={selected.text}
          isName={passage.names.includes(selected.text)}
          entries={words.filter((w) => w.simplified === selected.text)}
          user={user}
          summaries={summaries}
          onUserChange={onUserChange}
          onClose={() => setSelected(null)}
        />
      )}
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
      <TranslationExercises
        passage={passage}
        words={words}
        onUserChange={onUserChange}
      />
    </article>
  );
}

/**
 * A tapped word: every HSK entry with its form (homographs such as 行 have
 * several), with where it stands in review and an "add to SRS" action.
 */
function WordLookup({
  token,
  isName,
  entries,
  user,
  summaries,
  onUserChange,
  onClose,
}: {
  token: string;
  isName: boolean;
  entries: WordNote[];
  user: AuthUser;
  summaries: ReadonlyMap<string, CardSummary>;
  onUserChange: (user: AuthUser) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = pendingAddedWords(user.settings, summaries);

  async function change(wordId: string, add: boolean) {
    setBusy(wordId);
    try {
      const { user } = add
        ? await postJson<AuthResponse>('/settings/added-words', { wordId })
        : await deleteJson<AuthResponse>(
            `/settings/added-words/${encodeURIComponent(wordId)}`,
          );
      onUserChange(user);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function status(word: WordNote) {
    const summary = summaries.get(cardKey('word', word._id, 'pinyin'));
    if (summary) {
      if (summary.schedule.phase !== 'review') return <span>Learning</span>;
      const wait = summary.schedule.due.getTime() - Date.now();
      return (
        <span>
          In review · {wait > 0 ? `due in ${formatInterval(wait)}` : 'due now'}
        </span>
      );
    }
    const place = pending.indexOf(word._id);
    if (place >= 0) {
      return (
        <>
          <span>
            Added · {place === 0 ? 'next' : `#${place + 1}`} in line for new
            cards
          </span>{' '}
          <button
            type="button"
            className="link"
            disabled={busy !== null}
            onClick={() => void change(word._id, false)}
          >
            Remove
          </button>
        </>
      );
    }
    return (
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void change(word._id, true)}
      >
        {busy === word._id ? 'Adding…' : 'Add to SRS'}
      </button>
    );
  }

  return (
    <aside className="lookup" aria-label={`Look up ${token}`}>
      <button
        type="button"
        className="link close"
        onClick={onClose}
        aria-label="Close"
      >
        ✕
      </button>
      {entries.length === 0 ? (
        <p>
          <span lang="zh-Hans" className="lookup-word">
            {token}
          </span>{' '}
          <span className="hint">
            {isName ? 'A name.' : 'Not in the HSK word lists.'}
          </span>
        </p>
      ) : (
        entries.map((word) => (
          <div key={word._id} className="lookup-entry">
            <p>
              <span lang="zh-Hans" className="lookup-word">
                {word.simplified}
              </span>
              {word.traditional !== word.simplified && (
                <span lang="zh-Hant" className="hint">
                  {' '}
                  {word.traditional}
                </span>
              )}{' '}
              <span lang="zh-Latn-pinyin">
                {displayPinyin(word.citationPinyin)}
              </span>{' '}
              <span className="hint">HSK {HSK_LEVEL_LABELS[word.level]}</span>
            </p>
            {word.definitions.length > 0 && (
              <p>{word.definitions.slice(0, 3).join('; ')}</p>
            )}
            <p className="lookup-status">{status(word)}</p>
          </div>
        ))
      )}
      {error && (
        <p className="error" role="alert">
          Couldn’t save: {error}
        </p>
      )}
    </aside>
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
