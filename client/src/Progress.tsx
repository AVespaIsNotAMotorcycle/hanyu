import { useState } from 'react';
import { addDays, type DayActivity } from '@hanyu/shared';
import type { Activity } from './local/activity';

/** Weeks shown in the calendar. */
const WEEKS = 20;

/** How much was done: card answers, questions, and translations. */
const amount = (day: DayActivity) =>
  day.answers +
  day.readingQuestions +
  day.listeningQuestions +
  day.translations;

/** Calendar shade: 0 (nothing) to 4. */
function shade(day: DayActivity | undefined): number {
  const n = day ? amount(day) : 0;
  return n === 0 ? 0 : n < 20 ? 1 : n < 50 ? 2 : n < 100 ? 3 : 4;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function dateLabel(day: string, options: Intl.DateTimeFormatOptions) {
  // Noon UTC, formatted as UTC: the date in the key, whatever the time zone.
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    ...options,
    timeZone: 'UTC',
  });
}

const minutes = (ms: number) => Math.round(ms / 60000);

/** "24 reviewed · 10 new · 1 reading · 5 min". */
export function describeDay(day: DayActivity): string {
  const reading = day.readingExercises || day.readingQuestions;
  const listening = day.listeningExercises || day.listeningQuestions;
  return (
    [
      day.reviewedCards > 0 && `${day.reviewedCards} reviewed`,
      day.newCards > 0 && `${day.newCards} new`,
      day.readingExercises > 0
        ? `${plural(reading, 'passage')} read`
        : reading > 0 && `${plural(reading, 'reading question')}`,
      day.listeningExercises > 0
        ? `${plural(listening, 'listening exercise')}`
        : listening > 0 && `${plural(listening, 'listening question')}`,
      day.translations > 0 && plural(day.translations, 'translation'),
      minutes(day.durationMs) > 0 && `${minutes(day.durationMs)} min on cards`,
    ]
      .filter(Boolean)
      .join(' · ') || 'A few cards'
  );
}

/** Streaks, a calendar of recent study days, and what was done on each. */
export function Progress({ activity }: { activity: Activity | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!activity) return <p className="status">Loading your history…</p>;
  const { days, today, streaks } = activity;
  const byDay = new Map(days.map((d) => [d.day, d]));
  const answers = days.reduce((n, d) => n + d.answers, 0);
  const correct = days.reduce((n, d) => n + d.correct, 0);
  const stats = [
    ['Current streak', plural(streaks.current, 'day')],
    ['Longest streak', plural(streaks.longest, 'day')],
    ['Days studied', String(streaks.activeDays)],
    ['Cards answered', answers.toLocaleString()],
    ...(answers > 0
      ? [['Answered right', `${Math.round((correct / answers) * 100)}%`]]
      : []),
  ] as const;

  // Whole weeks, Monday first, ending with the week of today.
  const todayIndex = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const first = addDays(today, -(WEEKS - 1) * 7 - todayIndex);
  const calendar = Array.from(
    { length: (WEEKS - 1) * 7 + todayIndex + 1 },
    (_, i) => addDays(first, i),
  );
  const shown = selected ?? today;
  const shownDay = byDay.get(shown);

  return (
    <section className="progress">
      <dl className="stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <h2>Last {WEEKS} weeks</h2>
      <div className="calendar" role="group" aria-label="Study calendar">
        {calendar.map((day) => {
          const activityOfDay = byDay.get(day);
          const label = `${dateLabel(day, { month: 'short', day: 'numeric' })}: ${
            activityOfDay ? describeDay(activityOfDay) : 'nothing studied'
          }`;
          return (
            <button
              key={day}
              type="button"
              className={`shade-${shade(activityOfDay)}`}
              aria-label={label}
              aria-pressed={day === shown}
              title={label}
              onClick={() => setSelected(day)}
            />
          );
        })}
      </div>
      <p className="calendar-detail" role="status">
        <strong>
          {dateLabel(shown, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          })}
        </strong>
        : {shownDay ? describeDay(shownDay) : 'nothing studied'}
      </p>
      <h2>Recent days</h2>
      {days.length === 0 ? (
        <p className="hint">Nothing yet. Your study days will show up here.</p>
      ) : (
        <ul className="day-list">
          {days
            .slice(-14)
            .reverse()
            .map((day) => (
              <li key={day.day}>
                <span className="day-date">
                  {dateLabel(day.day, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                <span className="hint">{describeDay(day)}</span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
