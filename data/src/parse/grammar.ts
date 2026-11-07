import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GrammarPoint, HskLevel } from '@hanyu/shared';
import { rawDir } from '../paths.js';
import { parseLevel } from './hsk.js';

/** The syllabus's own columns, before English is added. */
export type SyllabusGrammarPoint = Omit<GrammarPoint, 'title' | 'explanation'>;

/** The syllabus's level labels, as used in the source files' names. */
export const GRAMMAR_LEVELS = ['1', '2', '3', '4', '5', '6', '7-9'];

interface RawGrammarRow {
  类别: string;
  类别名称: string;
  细目: string;
  语法内容: string;
}

const clean = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/ ?、 ?/g, '、')
    .trim();

/** Parses one level's grammar list (krmanik/HSK-3.0, "New HSK (2025)"). */
export function parseGrammar(
  json: string,
  level: HskLevel,
): SyllabusGrammarPoint[] {
  const rows = JSON.parse(json) as RawGrammarRow[];
  return rows.map((row, i) => ({
    _id: `g${level}-${String(i + 1).padStart(3, '0')}`,
    level,
    order: i + 1,
    category: clean(row.类别),
    name: clean(row.类别名称),
    item: clean(row.细目),
    content: clean(row.语法内容),
  }));
}

/** Every level's grammar list, from the downloaded sources. */
export function readGrammar(dir = rawDir): SyllabusGrammarPoint[] {
  return GRAMMAR_LEVELS.flatMap((label) =>
    parseGrammar(
      readFileSync(path.join(dir, `hsk-grammar-${label}.json`), 'utf8'),
      parseLevel(label),
    ),
  );
}
