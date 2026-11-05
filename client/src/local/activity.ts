import { useEffect, useState } from 'react';
import {
  buildActivity,
  cardRecall,
  computeStreaks,
  studyDayKey,
  type ActivityAnswer,
  type ActivityResponse,
  type DayActivity,
  type Streaks,
} from '@hanyu/shared';
import { getJson, timeZone } from '../api';
import { useLocalData } from './LocalData';

// The server's part of the history, kept so streaks still show offline.
const CACHE = 'activity-v2';

export interface Activity {
  /** Each active study day, oldest first. */
  days: DayActivity[];
  /** The current study day, as YYYY-MM-DD. */
  today: string;
  streaks: Streaks;
  /** Reading and listening answers, oldest first. */
  answers: ActivityAnswer[];
  questionCounts: Record<string, number>;
  /** How well each card is recalled, from `cardRecall`. */
  recall: Map<string, number>;
}

/**
 * The learner's history, from local review logs and the server's question
 * answers. Reloaded when logs change or `refresh` does; while offline it uses
 * the last answers fetched.
 */
export function useActivity(refresh?: unknown): Activity | null {
  const { store, revision } = useLocalData();
  const [activity, setActivity] = useState<Activity | null>(null);

  useEffect(() => {
    let cancelled = false;
    const show = async (server: ActivityResponse | undefined) => {
      const reviews = await store.allLogs();
      const days = buildActivity({ ...server, reviews, timeZone });
      const today = studyDayKey(new Date(), timeZone);
      if (!cancelled) {
        setActivity({
          days,
          today,
          streaks: computeStreaks(days, today),
          answers: server?.answers ?? [],
          questionCounts: server?.questionCounts ?? {},
          recall: cardRecall(reviews),
        });
      }
    };
    (async () => {
      // Local data first, so nothing waits on the network.
      await show(await store.getMeta<ActivityResponse>(CACHE));
      const server = await getJson<ActivityResponse>('/activity');
      await store.setMeta(CACHE, server);
      await show(server);
    })().catch(() => {
      // Offline, or signed out: the local history is already showing.
    });
    return () => {
      cancelled = true;
    };
  }, [store, revision, refresh]);

  return activity;
}
