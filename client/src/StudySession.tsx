import { useEffect, useState, type FormEvent } from 'react';
import {
  applyReview,
  displayPinyin,
  gradePinyin,
  LEARN_AHEAD_MS,
  newCardSchedule,
  parseSchedule,
  RATING_LABELS,
  ratingForPinyin,
  type CardSchedule,
  type PinyinGrade,
  type QueueCard,
  type QueueResponse,
  type Rating,
} from '@hanyu/shared';
import { getJson, timeZone } from './api';
import { formatInterval } from './format';
import { PinyinInput } from './PinyinInput';

interface SessionCard {
  card: QueueCard;
  /** Null until the first review of a new card. */
  schedule: CardSchedule | null;
}

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
 * Works through the review queue. (Re)learning cards come back within the
 * session once their step is due, or early if nothing else is left.
 */
export function StudySession({ onExit }: { onExit: () => void }) {
  const [queue, setQueue] = useState<SessionCard[] | null>(null);
  // Cards in a learning step, waiting to come back this session.
  const [waiting, setWaiting] = useState<SessionCard[]>([]);
  const [current, setCurrent] = useState<SessionCard | null>(null);
  const [answer, setAnswer] = useState('');
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<QueueResponse>(`/queue?tz=${encodeURIComponent(timeZone)}`)
      .then(({ cards }) => {
        const items = cards.map((card) => ({
          card,
          schedule: card.schedule && parseSchedule(card.schedule),
        }));
        setCurrent(items[0] ?? null);
        setQueue(items.slice(1));
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);

  /** Learning cards that are due first, then the queue, then learning cards early. */
  function advance(nextWaiting: SessionCard[]) {
    const now = Date.now();
    const byDue = [...nextWaiting].sort(
      (a, b) => a.schedule!.due.getTime() - b.schedule!.due.getTime(),
    );
    const ready = byDue[0] && byDue[0].schedule!.due.getTime() <= now;
    let next: SessionCard | undefined;
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
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!current) return;
    if (answered) {
      const next: SessionCard = { ...current, schedule: answered.next };
      const learning =
        next.schedule!.phase === 'learning' ||
        next.schedule!.phase === 'relearning';
      const soon = next.schedule!.due.getTime() - Date.now() <= LEARN_AHEAD_MS;
      advance(learning && soon ? [...waiting, next] : waiting);
      return;
    }
    if (!answer.trim()) return;
    const { word } = current.card;
    const grade = gradePinyin(
      answer,
      [word.citationPinyin, ...word.alternatePinyin],
      word.simplified,
    );
    const rating = ratingForPinyin(grade);
    const now = new Date();
    // Not saved yet: recording review logs is the next roadmap step.
    const next = applyReview(current.schedule ?? newCardSchedule(now), {
      rating,
      reviewedAt: now,
    });
    setAnswered({ grade, rating, next });
    setDone((n) => n + 1);
  }

  if (error) return <p className="error">{error}</p>;
  if (!queue) return <p className="status">Loading reviews…</p>;

  const remaining = queue.length + waiting.length + (current ? 1 : 0);
  return (
    <section className="session">
      <p className="session-bar">
        <button type="button" className="link" onClick={onExit}>
          ← Decks
        </button>
        <span>
          {done} reviewed · {remaining} left
        </span>
      </p>
      <p className="notice">Practice mode: reviews are not saved yet.</p>
      {current ? (
        <form className="card" onSubmit={submit}>
          {current.schedule === null && <span className="badge">New</span>}
          <p className="card-word" lang="zh-Hans">
            {current.card.word.simplified}
          </p>
          <p className="hint">{current.card.word.definitions[0]}</p>
          <PinyinInput
            key={`${current.card.key}-${done}`}
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
          <p>Done for now. {done} reviewed.</p>
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
