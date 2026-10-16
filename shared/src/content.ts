// Shapes of the seed dataset (data/seed) and of the matching MongoDB documents.

/** HSK 3.0 level. Levels 7–9 form one band, stored as 7. */
export type HskLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WordSyllable {
  simplified: string;
  traditional: string;
  /** Citation-tone pinyin with tone numbers, e.g. `xue2`. */
  pinyin: string;
}

export type CedictMatch = 'exact' | 'tones-differ' | 'none';

export interface WordNote {
  /** Stable ID from the syllabus entry number, e.g. `hsk30-00001`. */
  _id: string;
  hskId: number;
  level: HskLevel;
  /** Level as printed in the syllabus, e.g. `1（4）`. */
  levelLabel: string;
  simplified: string;
  traditional: string;
  /** Other traditional forms CC-CEDICT gives for the same reading. */
  traditionalVariants: string[];
  /** Syllabus homograph number (本1, 本2), or null. */
  homograph: number | null;
  /** Pinyin as printed in the syllabus. May show 一/不 tone sandhi. */
  pinyin: string;
  /**
   * Citation-tone pinyin with tone numbers, space-separated: `xue2 sheng1`.
   * Tones follow the syllabus, with 一/不 sandhi undone.
   */
  citationPinyin: string;
  /** Other accepted readings, same format (谁: `shui2` beside `shei2`). */
  alternatePinyin: string[];
  /** Per-character readings, or null when they could not be aligned. */
  syllables: WordSyllable[] | null;
  partsOfSpeech: string[];
  definitions: string[];
  /** Zipf frequency from wordfreq (0 if unknown). */
  zipf: number;
  /** 1-based introduction order within the level (most frequent first). */
  levelOrder: number;
  /** Distinct characters, in order of appearance. */
  characters: string[];
  cedictMatch: CedictMatch;
}

export interface CharacterNote {
  /** The simplified character. */
  _id: string;
  traditional: string[];
  /** Citation-tone readings used by HSK words, with tone numbers. */
  readings: string[];
  /** Level of the first word that introduces this character. */
  introLevel: HskLevel;
  /** ID of the first word (in introduction order) containing this character. */
  introducedBy: string;
  /** 1-based global introduction order. */
  introOrder: number;
  /** Level in the syllabus 认读字 (recognition) list, if listed. */
  hskReadLevel: HskLevel | null;
  /** Level in the syllabus 书写字 (handwriting) list, if listed. */
  hskWriteLevel: HskLevel | null;
}

/** Make Me a Hanzi dictionary.txt fields (LGPL-3.0-or-later). */
export interface CharacterDetails {
  _id: string;
  definition: string | null;
  radical: string | null;
  decomposition: string | null;
  etymology: {
    type: string;
    hint?: string;
    phonetic?: string;
    semantic?: string;
  } | null;
}

/** Make Me a Hanzi graphics.txt fields (Arphic Public License). */
export interface CharacterStrokes {
  _id: string;
  /** SVG path per stroke, in a 1024×1024 box with the y-axis flipped. */
  strokes: string[];
  /** Stroke medians as [x, y] points, used for stroke-order checking. */
  medians: [number, number][][];
}

export interface GrammarPoint {
  /** e.g. `g1-001` */
  _id: string;
  level: HskLevel;
  /** 1-based order within the level, as listed in the syllabus. */
  order: number;
  /** 类别, e.g. 词类 */
  category: string;
  /** 类别名称, e.g. 副词 */
  name: string;
  /** 细目, e.g. 程度副词 (may be empty) */
  item: string;
  /** 语法内容, e.g. 非常、很、太 (empty when the item is the whole point, e.g. 陈述句) */
  content: string;
}

export interface DatasetSource {
  id: string;
  url: string;
  sha256: string;
  license: string;
}

export interface DatasetManifest {
  version: string;
  sources: DatasetSource[];
  counts: Record<string, number>;
}

// --- Cards and reviews --------------------------------------------------------

export type NoteType = 'word' | 'character';

/**
 * Word notes get pinyin-production and meaning-recognition cards; character
 * notes get handwriting cards.
 */
export type CardKind = 'pinyin' | 'meaning' | 'handwriting';

/** FSRS rating: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type Rating = 1 | 2 | 3 | 4;

/** Deterministic card key, so devices that create a card offline agree on it. */
export function cardKey(
  noteType: NoteType,
  noteId: string,
  kind: CardKind,
): string {
  return `${noteType}:${noteId}:${kind}`;
}
