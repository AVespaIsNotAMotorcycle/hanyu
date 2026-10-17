// Two-way sync of review logs between IndexedDB and the server. Logs are
// append-only with client UUIDs, so sync is a union: push what the server
// lacks, pull what this device lacks. Re-sending or re-pulling is harmless.

import {
  MAX_REVIEWS_PER_REQUEST,
  PULL_OVERLAP_MS,
  type GetReviewsResponse,
  type PostReviewsResponse,
} from '@hanyu/shared';
import { ApiError, getJson, postJson } from '../api';
import type { LocalStore } from './store';

export interface SyncStatus {
  /** `offline`: the server couldn't be reached; reviews wait on this device. */
  state: 'idle' | 'syncing' | 'offline' | 'error';
  /** Reviews recorded here that the server doesn't have yet. */
  unsynced: number;
  lastSyncedAt: Date | null;
  error: string | null;
  /** HTTP status of the last failure, if the server answered (401: signed out). */
  errorStatus: number | null;
}

export interface SyncApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

const CURSOR = 'pullCursor';
const RETRY_MS = 5 * 60 * 1000;

export class Sync {
  status: SyncStatus = {
    state: 'idle',
    unsynced: 0,
    lastSyncedAt: null,
    error: null,
    errorStatus: null,
  };
  private running: Promise<void> | null = null;
  private again = false;
  private listeners = new Set<(status: SyncStatus) => void>();
  private changeListeners = new Set<() => void>();
  private stopTriggers: (() => void) | null = null;

  constructor(
    private readonly store: LocalStore,
    private readonly api: SyncApi = { get: getJson, post: postJson },
  ) {}

  /** Status updates (for the UI). Returns an unsubscribe function. */
  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when a pull brought in logs from another device. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  /**
   * Pushes, then pulls. Calls made while a sync runs are folded into one more
   * run after it, so a burst of reviews makes at most two round trips.
   */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce() {
    this.setStatus({
      state: 'syncing',
      unsynced: await this.store.countUnsynced(),
    });
    let failure: unknown = null;
    let pulled = 0;
    try {
      await this.push();
    } catch (err) {
      failure = err;
    }
    // A push the server refused (rather than couldn't receive) shouldn't
    // stop this device from getting other devices' reviews.
    if (!failure || failure instanceof ApiError) {
      try {
        pulled = await this.pull();
      } catch (err) {
        failure ??= err;
      }
    }
    const unsynced = await this.store.countUnsynced();
    if (failure) {
      this.setStatus({
        state: failure instanceof ApiError ? 'error' : 'offline',
        unsynced,
        error: failure instanceof Error ? failure.message : String(failure),
        errorStatus: failure instanceof ApiError ? failure.status : null,
      });
    } else {
      this.setStatus({
        state: 'idle',
        unsynced,
        lastSyncedAt: new Date(),
        error: null,
        errorStatus: null,
      });
    }
    if (pulled > 0) for (const listener of this.changeListeners) listener();
  }

  private async push() {
    for (;;) {
      const batch = await this.store.unsyncedLogs(MAX_REVIEWS_PER_REQUEST);
      if (batch.length === 0) return;
      const { accepted, duplicates } = await this.api.post<PostReviewsResponse>(
        '/reviews',
        {
          reviews: batch.map(({ synced: _, ...review }) => review),
        },
      );
      await this.store.markSynced([...accepted, ...duplicates]);
    }
  }

  /** Pulls logs stored since the last pull (with overlap); returns how many were new here. */
  private async pull(): Promise<number> {
    const cursor = await this.store.getMeta<string>(CURSOR);
    let query: { since?: string; after?: string } = cursor
      ? {
          since: new Date(
            new Date(cursor).getTime() - PULL_OVERLAP_MS,
          ).toISOString(),
        }
      : {};
    let added = 0;
    let newest = cursor;
    for (;;) {
      const params = new URLSearchParams(query).toString();
      const page = await this.api.get<GetReviewsResponse>(
        `/reviews${params ? `?${params}` : ''}`,
      );
      added += await this.store.putServerLogs(page.reviews);
      const last = page.reviews.at(-1)?.storedAt;
      if (last && (!newest || last > newest)) newest = last;
      if (!page.next) break;
      query = page.next;
    }
    if (newest && newest !== cursor) await this.store.setMeta(CURSOR, newest);
    return added;
  }

  /** Syncs now, whenever the browser comes back online or the tab is shown, and every few minutes. */
  start() {
    void this.sync();
    const run = () => void this.sync();
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(run, RETRY_MS);
    this.stopTriggers = () => {
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }

  stop() {
    this.stopTriggers?.();
    this.stopTriggers = null;
  }
}
