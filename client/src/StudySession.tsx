import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  applyReview,
  buildQueue,
  displayPinyin,
  gradePinyin,
  LEARN_AHEAD_MS,
  MAX_ANSWER_LENGTH,
  newCardSchedule,
  RATING_LABELS,
  ratingForPinyin,
  studyDayStart,
  type AuthUser,
  type CardSchedule,
  type PinyinGrade,
  type QueueItem,
  type Rating,
  type StudyMode,
} from '@hanyu/shared';
import { timeZone } from './api';
import { deviceId } from './device';
import { formatInterval } from './format';
import { useLocalData, useStudyData } from './local/LocalData';
import { PinyinInput } from './PinyinInput';

interface Answered {
  grade: PinyinGrade;
  rating: Rating;
  next: CardSchedule;
}

const VERDICTS: Record<PinyinGrade['verdict'], string> = {
  correct: 'Correct',
  tone: 'Tone error',
  wrong: 'Wrong syllable',
};

/**
 * Works through the review queue, built on this device from its logs.
 * (Re)learning cards come back within the session once their step is due,
 * or early if nothing else is left. Reviews are written to IndexedDB first,
 * so they survive going offline or closing the tab, then synced.
 */
export function StudySession({
  user,
  mode,
  onExit,
}: {
  user: AuthUser;
  mode: StudyMode;
  onExit: () => void;
}) {
  const { store, recorded } = useLocalData();
  const { data, error: loadError } = useStudyData(user.settings);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  // Cards in a learning step, waiting to come back this session.
  const [waiting, setWaiting] = useState<QueueItem[]>([]);
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const [answer, setAnswer] = useState('');
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const shownAt = useRef(Date.now());

  // Build the queue once, from the first snapshot; the session then runs on
  // its own state, so syncs mid-session don't reshuffle it.
  useEffect(() => {
    if (!data || queue) return;
    const now = new Date();
    const { cards } = buildQueue({
      ...data,
      settings: user.settings,
      now,
      dayStart: studyDayStart(now, timeZone),
      mode,
    });
    setCurrent(cards[0] ?? null);
    setQueue(cards.slice(1));
    shownAt.current = Date.now();
  }, [data, queue, user.settings, mode]);

  /** Learning cards that are due first, then the queue, then learning cards early. */
  function advance(nextWaiting: QueueItem[]) {
    const now = Date.now();
    const byDue = [...nextWaiting].sort(
      (a, b) => a.schedule!.due.getTime() - b.schedule!.due.getTime(),
    );
    const ready = byDue[0] && byDue[0].schedule!.due.getTime() <= now;
    let next: QueueItem | undefined;
    if (ready || queue!.length === 0) {
      next = byDue.shift();
    } else {
      next = queue![0];
      setQueue(queue!.slice(1));
    }
    setWaiting(byDue);
    setCurrent(next ?? null);
    setAnswer('');
    setAnswered(null);
    shownAt.current = Date.now();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!current) return;
    if (answered) {
      const next: QueueItem = { ...current, schedule: answered.next };
      const learning =
        next.schedule!.phase === 'learning' ||
        next.schedule!.phase === 'relearning';
      const soon = next.schedule!.due.getTime() - Date.now() <= LEARN_AHEAD_MS;
      // Flagged mode drills each card until it leaves learning.
      advance(learning && soon ? [...waiting, next] : waiting);
      return;
    }
    if (!answer.trim()) return;
    const { word } = current;
    const grade = gradePinyin(
      answer,
      [word.citationPinyin, ...word.alternatePinyin],
      word.simplified,
    );
    const rating = ratingForPinyin(grade);
    const now = new Date();
    const next = applyReview(current.schedule ?? newCardSchedule(now), {
      rating,
      reviewedAt: now,
    });
    try {
      await store.addLog({
        _id: crypto.randomUUID(),
        cardKey: current.key,
        rating,
        reviewedAt: now.toISOString(),
        answer: answer.slice(0, MAX_ANSWER_LENGTH),
        durationMs: now.getTime() - shownAt.current,
        deviceId,
      });
    } catch (err) {
      setError(`Couldn’t save this review on this device: ${String(err)}`);
      return;
    }
    recorded();
    setAnswered({ grade, rating, next });
    setDone((n) => n + 1);
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!queue) return <p className="status">Loading reviews…</p>;

  const remaining = queue.length + waiting.length + (current ? 1 : 0);
  return (
    <section className="session">
      <p className="session-bar">
        <button type="button" className="link" onClick={onExit}>
          ← Decks
        </button>
        <span>
          {mode === 'flagged' && 'Flagged · '}
          {done} reviewed · {remaining} left
        </span>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {current ? (
        <form className="card" onSubmit={(event) => void submit(event)}>
          <span className="badges">
            {current.schedule === null && <span className="badge">New</span>}
            {current.leech && (
              <span
                className="badge flagged"
                title="You’ve missed this one often"
              >
                Flagged
              </span>
            )}
          </span>
          <p className="card-word" lang="zh-Hans">
            {current.word.simplified}
          </p>
          <p className="hint">{current.word.definitions[0]}</p>
          <PinyinInput
            key={`${current.key}-${done}`}
            value={answer}
            onChange={setAnswer}
            readOnly={answered !== null}
            autoFocus
            aria-label="Pinyin"
            placeholder="Type pinyin, e.g. xue2sheng"
          />
          {answered && <Feedback answered={answered} />}
          <button type="submit">{answered ? 'Continue' : 'Check'}</button>
        </form>
      ) : (
        <div className="card">
          <p>
            {done === 0 && mode === 'flagged'
              ? 'No flagged cards right now.'
              : `Done for now. ${done} reviewed.`}
          </p>
          <button type="button" onClick={onExit}>
            Back to decks
          </button>
        </div>
      )}
    </section>
  );
}

function Feedback({
  answered: { grade, rating, next },
}: {
  answered: Answered;
}) {
  const sandhi = grade.syllables.some((s) => s.sandhi);
  return (
    <div className={`feedback ${grade.verdict}`} role="status">
      <strong>{VERDICTS[grade.verdict]}</strong>{' '}
      <span lang="zh-Latn-pinyin">
        {grade.verdict === 'wrong'
          ? displayPinyin(grade.reading)
          : grade.syllables.map((s, i) => (
              <span key={i} className={s.correct ? undefined : 'miss'}>
                {s.expected}
              </span>
            ))}
      </span>
      <p className="rating">
        {RATING_LABELS[rating]} · next in{' '}
        {formatInterval(next.due.getTime() - Date.now())}
      </p>
      {sandhi && (
        <p className="hint">
          That’s the tone-sandhi pronunciation. Type citation tones.
        </p>
      )}
    </div>
  );
}
