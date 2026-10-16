import {
  comparablePinyin,
  numberedToMarked,
  stripTones,
  toneOf,
  type CedictMatch,
} from '@hanyu/shared';
import type { CedictEntry } from './parse/cedict.js';

export interface MatchResult {
  match: CedictMatch;
  /** Matching entries, best first. */
  entries: CedictEntry[];
}

const comparableCedict = (pinyin: string) =>
  comparablePinyin(numberedToMarked(pinyin));

/** Counts syllables whose tone marks differ between two toneless-equal strings. */
function toneDifferences(a: string, b: string): number {
  const marks = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[^̀-̄̌a-zü]/g, '')
      .replace(/([a-zü])(?=[a-zü])/g, '$1 ')
      .split(' ');
  const ma = marks(a);
  const mb = marks(b);
  let diff = 0;
  for (let i = 0; i < Math.max(ma.length, mb.length); i++)
    if (ma[i] !== mb[i]) diff++;
  return diff;
}

/** Prefers ordinary entries over surnames, variants, and cross-references. */
function entryScore(entry: CedictEntry): number {
  const minor =
    /^(surname |(old |archaic )?variant of |used in |see |abbr\. for )/;
  const useful = entry.definitions.filter((d) => !minor.test(d)).length;
  // Lowercase pinyin = common noun; capitalized = proper noun.
  const proper = /^[A-Z]/.test(entry.pinyin) ? 1 : 0;
  return useful * 10 - proper * 5 + entry.definitions.length;
}

/**
 * Finds the CC-CEDICT entries that match a syllabus word's pinyin. Exact
 * matches win. Otherwise entries with the same syllables but different tones
 * are accepted, fewest differences first; this covers the syllabus printing
 * 一/不 sandhi (bú kèqi) where CC-CEDICT gives citation tones (bu4 ke4 qi5).
 */
export function matchCedict(
  pinyin: string,
  candidates: CedictEntry[],
): MatchResult {
  const target = comparablePinyin(pinyin);
  const byScore = (a: CedictEntry, b: CedictEntry) =>
    entryScore(b) - entryScore(a);

  const exact = candidates.filter((e) => comparableCedict(e.pinyin) === target);
  if (exact.length) return { match: 'exact', entries: exact.sort(byScore) };

  const toneless = stripTones(target);
  const close = candidates
    .filter((e) => stripTones(comparableCedict(e.pinyin)) === toneless)
    .map((e) => ({
      e,
      diff: toneDifferences(comparableCedict(e.pinyin), target),
    }))
    .sort((a, b) => a.diff - b.diff || byScore(a.e, b.e));
  if (close.length) {
    const best = close[0]!.diff;
    return {
      match: 'tones-differ',
      entries: close.filter((c) => c.diff === best).map((c) => c.e),
    };
  }
  return { match: 'none', entries: [] };
}

/**
 * For words missing from CC-CEDICT, splits the word into the longest
 * dictionary words whose pinyin lines up with the syllabus pinyin, and joins
 * their entries. Returns null if no split works.
 */
export function composeFromParts(
  simplified: string,
  pinyin: string,
  dictionary: Map<string, CedictEntry[]>,
): CedictEntry[] | null {
  const chars = [...simplified];
  const target = stripTones(comparablePinyin(pinyin));

  function solve(start: number, offset: number): CedictEntry[] | null {
    if (start === chars.length) return offset === target.length ? [] : null;
    for (let end = chars.length; end > start; end--) {
      if (start === 0 && end === chars.length) continue; // the whole word is what's missing
      const part = chars.slice(start, end).join('');
      for (const entry of dictionary.get(part) ?? []) {
        const reading = stripTones(comparableCedict(entry.pinyin));
        if (!target.startsWith(reading, offset)) continue;
        const rest = solve(end, offset + reading.length);
        if (rest) return [entry, ...rest];
      }
    }
    return null;
  }

  return solve(0, 0);
}

// 一 and 不 change tone by context (tone sandhi), and the syllabus prints the
// changed tone. Maps each to its citation syllable and the printed tones that
// are sandhi forms; a neutral tone (对不起 duìbuqǐ) is kept as printed.
const SANDHI: Record<string, { citation: string; sandhiTones: number[] }> = {
  一: { citation: 'yi1', sandhiTones: [2, 4] },
  不: { citation: 'bu4', sandhiTones: [2] },
};

/**
 * Builds citation pinyin with tone numbers (`xue2 sheng1`) from the syllabus
 * pinyin, using CC-CEDICT's syllables to find the syllable boundaries.
 * Tones come from the syllabus, except that 一 and 不 get their citation
 * tones back. Returns null if the two don't line up.
 */
export function citationFromSyllabus(
  syllabus: string,
  cedictPinyin: string,
  simplified: string,
): string | null {
  const target = [...comparablePinyin(syllabus).normalize('NFD')];
  const chars = [...simplified];
  const tokens = cedictPinyin.toLowerCase().split(' ');
  if (tokens.length !== chars.length) return null;

  let i = 0;
  const syllables: string[] = [];
  for (const [index, token] of tokens.entries()) {
    const base = stripTones(comparableCedict(token));
    let chunk = '';
    while (i < target.length && stripTones(chunk.normalize('NFC')) !== base) {
      chunk += target[i++];
      while (i < target.length && /[\u0300-\u036f]/.test(target[i]!))
        chunk += target[i++];
    }
    if (stripTones(chunk.normalize('NFC')) !== base) return null;
    const tone = toneOf(chunk);
    const sandhi = SANDHI[chars[index]!];
    const undo =
      sandhi &&
      sandhi.citation.startsWith(base) &&
      sandhi.sandhiTones.includes(tone);
    syllables.push(undo ? sandhi.citation : `${base}${tone}`);
  }
  return i === target.length ? syllables.join(' ') : null;
}
