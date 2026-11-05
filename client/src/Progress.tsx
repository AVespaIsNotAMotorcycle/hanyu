import { useState } from 'react';
import {
  addDays,
  buildDecks,
  buildReadiness,
  FIRST_TRY_TARGET,
  type AuthUser,
  type DayActivity,
  type LevelReadiness,
} from '@hanyu/shared';
import type { Activity } from './local/activity';
import { useStudyData } from './local/LocalData';

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

const percent = (share: number) => `${Math.round(share * 100)}%`;

function ReadinessRow({ level }: { level: LevelReadiness }) {
  const parts = [
    `Words ${percent(level.started)}`,
    level.recall !== null && `Recall ${percent(level.recall)}`,
    `Reading ${level.reading === null ? 'none this week' : percent(level.reading)}`,
    `Listening ${level.listening === null ? 'none this week' : percent(level.listening)}`,
  ];
  return (
    <li>
      <span className="deck-name">HSK {level.label}</span>
      <progress
        value={level.score}
        max={100}
        aria-label={`HSK ${level.label} exam readiness`}
      />
      <span className="deck-count readiness-score">{level.score}%</span>
      <span className="hint deck-detail">
        {parts.filter(Boolean).join(' · ')}
      </span>
    </li>
  );
}

/** Streaks, a calendar of recent study days, and progress through each level. */
export function Progress({
  user,
  activity,
}: {
  user: AuthUser;
  activity: Activity | null;
}) {
  const { data } = useStudyData(user.settings);
  const [selected, setSelected] = useState<string | null>(null);
  if (!activity) return <p className="status">Loading your history…</p>;
  const { days, today, streaks } = activity;
  const byDay = new Map(days.map((d) => [d.day, d]));
  const answers = days.reduce((n, d) => n + d.answers, 0);
  const correct = days.reduce((n, d) => n + d.correct, 0);
  const started = days.reduce((n, d) => n + d.newCards, 0);
  const stats = [
    ['Current streak', plural(streaks.current, 'day')],
    ['Longest streak', plural(streaks.longest, 'day')],
    ['Days studied', String(streaks.activeDays)],
    ['Cards started', started.toLocaleString()],
    ['Cards answered', answers.toLocaleString()],
    [
      'Answered right',
      answers ? `${Math.round((correct / answers) * 100)}%` : '–',
    ],
  ] as const;

  // Whole weeks, Monday first, ending with the week of today.
  const todayIndex = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const first = addDays(today, -(WEEKS - 1) * 7 - todayIndex);
  const calendar = Array.from(
    { length: (WEEKS - 1) * 7 + todayIndex + 1 },
    (_, i) => addDays(first, i),
  );
  const decks = data?.dataset
    ? buildDecks({
        ...data,
        dataset: data.dataset,
        settings: user.settings,
        now: new Date(),
      })
    : null;
  const readiness = data?.dataset
    ? buildReadiness({
        ...data,
        dataset: data.dataset,
        recall: activity.recall,
        answers: activity.answers,
        questionCounts: activity.questionCounts,
        now: new Date(),
      }).filter(
        (level) =>
          level.started > 0 ||
          level.reading !== null ||
          level.listening !== null ||
          user.settings.levels.includes(level.level),
      )
    : null;
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
      {readiness && (
        <>
          <h2>Exam readiness</h2>
          <ul className="deck-list readiness">
            {readiness.map((level) => (
              <ReadinessRow key={level.level} level={level} />
            ))}
          </ul>
          <p className="hint readiness-note">
            An estimate. Words count pinyin and handwriting for the level.
            Reading and listening count your first try at exercises finished at
            that level in the last 7 days, with {percent(FIRST_TRY_TARGET)}{' '}
            earning full marks and none counting as zero.
          </p>
        </>
      )}
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
      <p className="calendar-legend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((n) => (
          <i key={n} className={`shade-${n}`} />
        ))}
        <span>More</span>
      </p>
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
      {decks && (
        <>
          <h2>HSK levels</h2>
          <ul className="deck-list">
            {decks.map((deck) => (
              <li key={deck.level}>
                <span className="deck-name">HSK {deck.label}</span>
                <progress
                  value={deck.started}
                  max={deck.total || 1}
                  aria-label={`HSK ${deck.label} cards started`}
                />
                <span className="deck-count">
                  {deck.started.toLocaleString()} /{' '}
                  {deck.total.toLocaleString()}
                </span>
                {(deck.due > 0 || deck.flagged > 0) && (
                  <span className="hint deck-detail">
                    {[
                      deck.due > 0 && `${deck.due} due`,
                      deck.flagged > 0 && `${deck.flagged} flagged`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
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
