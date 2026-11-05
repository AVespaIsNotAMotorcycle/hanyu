import {
  addDays,
  buildQueue,
  dailyChecklist,
  parseCardKey,
  studyDayStart,
  type AuthUser,
  type ChecklistId,
  type ChecklistItem,
  type StudyMode,
} from '@hanyu/shared';
import { timeZone } from './api';
import type { Activity } from './local/activity';
import { useStudyData } from './local/LocalData';

const LABELS: Record<ChecklistId, string> = {
  review: 'Review',
  new: 'New words',
  reading: 'Reading exercise',
  listening: 'Listening exercise',
};

function detail({ id, done, count, goal }: ChecklistItem): string {
  if (id === 'reading') {
    return done
      ? 'Passage finished'
      : 'Answer the questions and translate a passage';
  }
  if (id === 'listening') {
    return done ? 'Exercise finished' : 'Answer every question in an exercise';
  }
  if (id === 'review') {
    if (goal === 0) return 'Nothing due';
    return done ? `${count} reviewed` : `${goal - count} due`;
  }
  if (goal === 0) return 'None left today';
  return done ? `${count} learned` : `${goal - count} to learn`;
}

/** What to do today: a checklist, each item leading to the work itself. */
export function Today({
  user,
  activity,
  onStudy,
  onOpen,
}: {
  user: AuthUser;
  activity: Activity | null;
  onStudy: (mode: StudyMode) => void;
  onOpen: (tab: 'read' | 'listen') => void;
}) {
  const { data, error } = useStudyData(user.settings);
  if (error) return <p className="error">{error}</p>;
  if (!data || !activity) return <p className="status">Loading today…</p>;

  const now = new Date();
  const queue = buildQueue({
    ...data,
    settings: user.settings,
    now,
    dayStart: studyDayStart(now, timeZone),
  });
  const items = dailyChecklist(
    activity.days.find((d) => d.day === activity.today),
    queue,
  );
  const flagged = [...data.summaries.values()].filter(
    (s) =>
      s.leech &&
      (parseCardKey(s.key)?.kind !== 'handwriting' ||
        user.settings.handwriting.enabled),
  ).length;

  const open: Record<ChecklistId, (() => void) | null> = {
    review: queue.dueCount > 0 ? () => onStudy('review') : null,
    // Handwriting cards for today's words are new cards too.
    new: queue.newCount > 0 ? () => onStudy('new') : null,
    reading: () => onOpen('read'),
    listening: () => onOpen('listen'),
  };
  const done = items.filter((item) => item.done).length;
  const active = new Set(activity.days.map((d) => d.day));
  const week = Array.from({ length: 7 }, (_, i) =>
    addDays(activity.today, i - 6),
  );
  const { current, activeToday } = activity.streaks;

  return (
    <section className="today">
      <header className="today-head">
        <h2>
          {new Date().toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </h2>
        <p className="hint">
          {done === items.length
            ? 'Everything’s done. See you tomorrow!'
            : `${done} of ${items.length} done`}
        </p>
        <progress value={done} max={items.length} aria-label="Today’s goals" />
      </header>
      <div className="streak-card">
        <p>
          <strong>
            {current} {current === 1 ? 'day' : 'days'}
          </strong>{' '}
          <span className="hint">
            {current === 0
              ? 'Study today to start a streak'
              : activeToday
                ? 'streak'
                : 'streak: study today to keep it'}
          </span>
        </p>
        <ol className="week" aria-label="Last seven days">
          {week.map((day) => {
            const date = new Date(`${day}T12:00:00Z`);
            const weekday = date.toLocaleDateString(undefined, {
              weekday: 'narrow',
              timeZone: 'UTC',
            });
            const name = date.toLocaleDateString(undefined, {
              weekday: 'long',
              timeZone: 'UTC',
            });
            return (
              <li
                key={day}
                className={[
                  active.has(day) ? 'active' : '',
                  day === activity.today ? 'now' : '',
                ].join(' ')}
              >
                <span aria-hidden="true">{weekday}</span>
                <span className="dot" aria-hidden="true">
                  {active.has(day) ? '✓' : ''}
                </span>
                <span className="visually-hidden">
                  {name}: {active.has(day) ? 'studied' : 'not studied'}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <ul className="checklist">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={item.done ? 'done' : undefined}
              onClick={open[item.id] ?? undefined}
              disabled={!open[item.id]}
            >
              <span className="check" aria-hidden="true">
                {item.done ? '✓' : ''}
              </span>
              <span className="label">
                {LABELS[item.id]}
                <span className="visually-hidden">
                  {item.done ? ' (done)' : ''}
                </span>
                <span className="detail">{detail(item)}</span>
              </span>
              <span className="chevron" aria-hidden="true">
                {open[item.id] ? '›' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {flagged > 0 && (
        <button
          type="button"
          className="flagged-study"
          onClick={() => onStudy('flagged')}
        >
          Study flagged cards · {flagged}
        </button>
      )}
    </section>
  );
}
