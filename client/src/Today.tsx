import {
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
    return done ? 'Passage finished' : 'Answer every question in a passage';
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

  return (
    <section className="today">
      <h2>Today</h2>
      <p className="hint">
        {done === items.length
          ? 'Everything’s done. See you tomorrow!'
          : `${done} of ${items.length} done`}
      </p>
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
              </span>
              <span className="detail">{detail(item)}</span>
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
