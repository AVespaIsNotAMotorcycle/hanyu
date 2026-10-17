import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  displayPinyin,
  gradePinyin,
  RATING_LABELS,
  ratingForPinyin,
  type PinyinGrade,
  type WordNote,
  type WordSampleResponse,
} from '@hanyu/shared';
import { getJson } from './api';
import { PinyinInput } from './PinyinInput';

const VERDICTS: Record<PinyinGrade['verdict'], string> = {
  correct: 'Correct',
  tone: 'Tone error',
  wrong: 'Wrong syllable',
};

/**
 * Practice typing pinyin for random words at a level. Nothing is recorded;
 * this stands in until the review queue exists.
 */
export function PinyinDrill() {
  const [level, setLevel] = useState(1);
  const [word, setWord] = useState<WordNote | null>(null);
  const [answer, setAnswer] = useState('');
  const [grade, setGrade] = useState<PinyinGrade | null>(null);
  const [error, setError] = useState<string | null>(null);

  const next = useCallback(async (atLevel: number) => {
    setAnswer('');
    setGrade(null);
    try {
      const { word } = await getJson<WordSampleResponse>(
        `/words/sample?level=${atLevel}`,
      );
      setWord(word);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void next(level);
  }, [level, next]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!word) return;
    if (grade) {
      void next(level);
    } else if (answer.trim()) {
      setGrade(
        gradePinyin(
          answer,
          [word.citationPinyin, ...word.alternatePinyin],
          word.simplified,
        ),
      );
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!word) return <p className="status">Loading a word…</p>;

  return (
    <form className="drill" onSubmit={submit}>
      <label className="drill-level">
        HSK level{' '}
        <select
          value={level}
          onChange={(event) => setLevel(Number(event.target.value))}
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value={7}>7–9</option>
        </select>
      </label>
      <p className="drill-word" lang="zh-Hans">
        {word.simplified}
      </p>
      <p className="hint">{word.definitions[0]}</p>
      <PinyinInput
        value={answer}
        onChange={setAnswer}
        readOnly={grade !== null}
        autoFocus
        aria-label="Pinyin"
        placeholder="Type pinyin, e.g. xue2sheng"
      />
      {grade && <Feedback grade={grade} />}
      <button type="submit">{grade ? 'Next word' : 'Check'}</button>
    </form>
  );
}

function Feedback({ grade }: { grade: PinyinGrade }) {
  const sandhi = grade.syllables.some((s) => s.sandhi);
  return (
    <div className={`feedback ${grade.verdict}`} role="status">
      <strong>{VERDICTS[grade.verdict]}</strong>{' '}
      <span className="rating">
        (would rate {RATING_LABELS[ratingForPinyin(grade)]})
      </span>{' '}
      <span lang="zh-Latn-pinyin">
        {grade.verdict === 'wrong'
          ? displayPinyin(grade.reading)
          : grade.syllables.map((s, i) => (
              <span key={i} className={s.correct ? undefined : 'miss'}>
                {s.expected}
              </span>
            ))}
      </span>
      {sandhi && (
        <p className="hint">
          That’s the tone-sandhi pronunciation. Type citation tones.
        </p>
      )}
    </div>
  );
}
