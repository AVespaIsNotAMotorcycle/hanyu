// Pinyin helpers shared by the data pipeline (matching syllabus pinyin to
// CC-CEDICT) and the client (rendering typed tone numbers as diacritics).

const TONE_MARKS: Record<string, readonly string[]> = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

// Combining marks for tones 1–4. The diaeresis on ü (U+0308) is not a tone.
const TONE_COMBINING_MARKS = ['\u0304', '\u0301', '\u030C', '\u0300'];
const TONE_COMBINING = /[\u0304\u0301\u030C\u0300]/g;

const NUMBERED_SYLLABLE = /([a-zü]+)([1-5])/gi;

/** Rewrites `u:` and `v` (common ASCII spellings of ü) as `ü`. */
export function normalizeUmlaut(text: string): string {
  return text
    .replace(/u:/gi, (m) => (m[0] === 'U' ? 'Ü' : 'ü'))
    .replace(/v/g, 'ü')
    .replace(/V/g, 'Ü');
}

function markSyllable(syllable: string, tone: number): string {
  if (tone < 1 || tone > 4) return syllable;
  const lower = syllable.toLowerCase();
  // Standard placement: a or e takes the mark; in "ou" the o does; otherwise the last vowel.
  let index = lower.search(/[ae]/);
  if (index === -1) index = lower.indexOf('ou');
  if (index === -1) {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ('iouü'.includes(lower[i]!)) {
        index = i;
        break;
      }
    }
  }
  if (index === -1) {
    // Syllabic m/n/ng interjections (嗯 ǹg, 呣 m̀) carry the mark on the consonant.
    const nasal = lower.search(/[mn]/);
    if (nasal === -1) return syllable; // e.g. erhua "r"
    const withMark = syllable[nasal]! + TONE_COMBINING_MARKS[tone - 1]!;
    return (
      syllable.slice(0, nasal) +
      withMark +
      syllable.slice(nasal + 1)
    ).normalize('NFC');
  }
  const vowel = lower[index]!;
  let marked = TONE_MARKS[vowel]![tone - 1]!;
  if (syllable[index] !== vowel) marked = marked.toUpperCase();
  return syllable.slice(0, index) + marked + syllable.slice(index + 1);
}

/**
 * Converts tone-numbered pinyin to tone marks. Works on spaced input
 * (`xue2 sheng5`), run-together input (`xue2sheng5`), and `u:`/`v` for ü.
 * Tone 5 (neutral) drops its number.
 */
export function numberedToMarked(text: string): string {
  return normalizeUmlaut(text).replace(
    NUMBERED_SYLLABLE,
    (_m, syllable: string, tone: string) =>
      markSyllable(syllable, Number(tone)),
  );
}

/** Returns the tone (1–4, or 5 for neutral) marked in a syllable. */
export function toneOf(syllable: string): number {
  const marks = syllable.normalize('NFD');
  const index = TONE_COMBINING_MARKS.findIndex((mark) => marks.includes(mark));
  return index === -1 ? 5 : index + 1;
}

/** Removes tone marks, keeping ü. */
export function stripTones(text: string): string {
  return text.normalize('NFD').replace(TONE_COMBINING, '').normalize('NFC');
}

/**
 * Canonical form for comparing pinyin strings: lowercase, NFC, ü spelled out,
 * and spaces, hyphens, apostrophes, and middle dots removed. Also maps the
 * IPA look-alikes ɑ and ɡ, which some printed sources use, to a and g.
 */
export function comparablePinyin(text: string): string {
  return normalizeUmlaut(text.normalize('NFC'))
    .toLowerCase()
    .replace(/ɑ/g, 'a')
    .replace(/ɡ/g, 'g')
    .replace(/[\s\-'’·]/g, '');
}
