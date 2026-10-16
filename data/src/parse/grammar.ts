import type { GrammarPoint, HskLevel } from '@hanyu/shared';

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
export function parseGrammar(json: string, level: HskLevel): GrammarPoint[] {
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
