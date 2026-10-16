import type { HskLevel } from '@hanyu/shared';
import { parseCsv } from './csv.js';

export interface HskWordRow {
  hskId: number;
  level: HskLevel;
  levelLabel: string;
  simplified: string;
  homograph: number | null;
  pinyin: string;
  partsOfSpeech: string[];
}

/** Maps a syllabus level label (`1`, `7-9`, `1-2`) to its HSK level. */
export function parseLevel(label: string): HskLevel {
  if (label === '7-9') return 7;
  // Combined lists like the 1–2 handwriting list count toward their upper level.
  const upper = Number(label.split('-').at(-1));
  if (!Number.isInteger(upper) || upper < 1 || upper > 7) {
    throw new Error(`Unrecognized HSK level: ${label}`);
  }
  return upper as HskLevel;
}

/** Parses hsk-words.csv (uranbekanarbaev/hsk-3.0-vocabulary-dataset). */
export function parseHskWords(csv: string): HskWordRow[] {
  return parseCsv(csv).map((r) => ({
    hskId: Number(r.id),
    level: parseLevel(r.level!),
    levelLabel: r.level_label!,
    simplified: r.hanzi!,
    homograph: r.homograph ? Number(r.homograph) : null,
    pinyin: r.pinyin!.normalize('NFC'),
    // "数、（副）": the parenthesized part of speech is introduced at a later level.
    partsOfSpeech: r
      .part_of_speech!.split('、')
      .map((p) => p.replace(/[（）()]/g, '').trim())
      .filter(Boolean),
  }));
}

/** Parses an HSK character list: one character per line. */
export function parseCharacterList(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}
