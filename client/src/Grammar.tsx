import { useEffect, useState } from 'react';
import {
  grammarIndex,
  HSK_LEVEL_LABELS,
  knownShare,
  passageFamiliarity,
  type AuthUser,
  type CardSummary,
  type GrammarPoint,
  type GrammarResponse,
  type PassagesResponse,
  type PassageSummary,
} from '@hanyu/shared';
import { getJson } from './api';
import { useStudyData } from './local/LocalData';
import { PassageItem, PassageView } from './Reading';
import { navigate, navigateUp } from './route';

const NO_CARDS: ReadonlyMap<string, CardSummary> = new Map();

/** The grammar in reading passages, easiest passages to read first. */
export function Grammar({
  user,
  passage: open,
  onUserChange,
}: {
  user: AuthUser;
  /** The passage opened from here, from the URL. */
  passage: string | null;
  onUserChange: (user: AuthUser) => void;
}) {
  const { data, error: cardsError } = useStudyData(user.settings);
  const summaries = data?.summaries ?? NO_CARDS;
  const [points, setPoints] = useState<GrammarPoint[] | null>(null);
  const [passages, setPassages] = useState<PassageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reloaded on returning from a passage, for its progress.
  useEffect(() => {
    if (open) return;
    Promise.all([
      getJson<GrammarResponse>('/grammar'),
      getJson<PassagesResponse>('/passages'),
    ])
      .then(([grammar, list]) => {
        setPoints(grammar.points);
        setPassages(list.passages);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [open]);

  if (open) {
    return (
      <PassageView
        key={open}
        id={open}
        user={user}
        summaries={summaries}
        onUserChange={onUserChange}
        onBack={() => navigateUp({ name: 'grammar' })}
        backLabel="Grammar"
      />
    );
  }
  if (error) return <p className="error">Couldn’t load grammar: {error}</p>;
  // Waits for the cards too, so the order doesn't change after it shows.
  if (!points || !passages || (!data && !cardsError)) {
    return <p className="status">Loading grammar…</p>;
  }

  const entries = grammarIndex(points, passages, summaries);
  return (
    <section className="reading">
      <h2>Grammar</h2>
      <p className="hint">
        Grammar points from the reading passages. Points come first when you
        know more of the words in a passage that uses them.
      </p>
      {entries.length === 0 ? (
        <p className="hint">No passages yet.</p>
      ) : (
        <ul className="grammar-list">
          {entries.map(({ point, passages, bestKnown }) => (
            <li key={point._id}>
              <h3>{point.title}</h3>
              <p className="hint">
                HSK {HSK_LEVEL_LABELS[point.level]}
                {data &&
                  ` · Up to ${Math.round(bestKnown * 100)}% of words known`}
              </p>
              <p>{point.explanation}</p>
              <ul className="passage-list">
                {passages.map((passage) => (
                  <li key={passage._id}>
                    <PassageItem
                      passage={passage}
                      familiarity={
                        data
                          ? passageFamiliarity(passage.vocabulary, summaries)
                          : null
                      }
                      onOpen={() =>
                        navigate({ name: 'grammar', passage: passage._id })
                      }
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
