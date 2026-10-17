import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ACTIVE_CARD_KINDS,
  parseCardKey,
  summarizeCards,
  type AuthUser,
  type CardSummary,
  type CharacterContent,
  type DatasetResponse,
  type HskLevel,
  type WordNote,
} from '@hanyu/shared';
import { loadCharacters, loadContent } from './content';
import { LocalStore } from './store';
import { Sync, type SyncStatus } from './sync';

interface LocalData {
  store: LocalStore;
  sync: Sync;
  status: SyncStatus;
  /** Bumped whenever logs change (a review here, or a pull from elsewhere). */
  revision: number;
  /** Call after recording a review: refreshes views and syncs. */
  recorded: () => void;
}

const Context = createContext<LocalData | null>(null);

/** Opens the signed-in user's local database and keeps it synced. */
export function LocalDataProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const [value, setValue] = useState<LocalData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    LocalStore.open(userId)
      .then((store) => {
        if (cancelled) return store.close();
        const sync = new Sync(store);
        const bump = () =>
          setValue((v) => v && { ...v, revision: v.revision + 1 });
        const offStatus = sync.onStatus((status) =>
          setValue((v) => v && { ...v, status }),
        );
        const offChange = sync.onChange(bump);
        setValue({
          store,
          sync,
          status: sync.status,
          revision: 0,
          recorded: () => {
            bump();
            void sync.sync();
          },
        });
        sync.start();
        cleanup = () => {
          sync.stop();
          offStatus();
          offChange();
          store.close();
        };
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [userId]);

  if (error) {
    return (
      <p className="error">
        This browser can’t store reviews (IndexedDB unavailable): {error}
      </p>
    );
  }
  if (!value) return <p className="status">Opening your reviews…</p>;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLocalData(): LocalData {
  const value = useContext(Context);
  if (!value) throw new Error('useLocalData outside LocalDataProvider');
  return value;
}

export interface StudyData {
  summaries: Map<string, CardSummary>;
  words: Map<string, WordNote>;
  /** Stroke data for the characters of started words (handwriting on). */
  characters: Map<string, CharacterContent>;
  dataset: DatasetResponse | null;
  /** Content came from the cache because the server was unreachable. */
  offline: boolean;
}

/**
 * Cards (replayed from local logs) and the words they need, reloaded when
 * logs or settings change.
 */
export function useStudyData(settings: AuthUser['settings']): {
  data: StudyData | null;
  error: string | null;
} {
  const { store, revision } = useLocalData();
  const [data, setData] = useState<StudyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const levels = settings.levels.join(',');
  // Users cached before added words existed have none.
  const added = (settings.addedWords ?? []).join(',');
  const handwriting = settings.handwriting.enabled;
  const datasetChecked = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const logs = (await store.allLogs()).filter((log) => {
        const kind = parseCardKey(log.cardKey)?.kind;
        return kind && ACTIVE_CARD_KINDS.includes(kind);
      });
      const summaries = summarizeCards(logs);
      // Started cards' words, and added words (the next new cards).
      const wordIds = [
        ...[...summaries.keys()].map((key) => parseCardKey(key)!.noteId),
        ...(added ? added.split(',') : []),
      ];
      const content = await loadContent(
        store,
        levels ? (levels.split(',').map(Number) as HskLevel[]) : [],
        wordIds,
        { checkDataset: !datasetChecked.current },
      );
      if (!content.offline) datasetChecked.current = true;
      // Handwriting cards need the characters of every started word.
      const characterIds = handwriting
        ? [...summaries.keys()].flatMap((key) => {
            const { noteType, noteId } = parseCardKey(key)!;
            return noteType === 'character'
              ? [noteId]
              : (content.words.get(noteId)?.characters ?? []);
          })
        : [];
      const characters = await loadCharacters(store, characterIds);
      if (!cancelled) {
        setData({ summaries, characters, ...content });
        setError(null);
      }
    })().catch((err: unknown) => {
      if (!cancelled)
        setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [store, revision, levels, added, handwriting]);

  return { data, error };
}
