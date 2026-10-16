export interface CedictEntry {
  traditional: string;
  simplified: string;
  /** Tone-numbered pinyin as written in CC-CEDICT, e.g. `xue2 sheng5`. */
  pinyin: string;
  definitions: string[];
}

const LINE = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;

/** Parses CC-CEDICT text into entries grouped by simplified form. */
export function parseCedict(text: string): Map<string, CedictEntry[]> {
  const bySimplified = new Map<string, CedictEntry[]>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.trim()) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const entry: CedictEntry = {
      traditional: m[1]!,
      simplified: m[2]!,
      pinyin: m[3]!,
      definitions: m[4]!.split('/').filter(Boolean),
    };
    const list = bySimplified.get(entry.simplified);
    if (list) list.push(entry);
    else bySimplified.set(entry.simplified, [entry]);
  }
  return bySimplified;
}

/** Reads the `#! key=value` header lines (version, date, entries). */
export function cedictHeader(text: string): Record<string, string> {
  const header: Record<string, string> = {};
  for (const line of text.split(/\r?\n/, 50)) {
    const m = /^#! (\w+)=(.*)$/.exec(line);
    if (m) header[m[1]!] = m[2]!.trim();
  }
  return header;
}
