// The calibration set: Chinese → English translations of TED talks with
// expert MQM error annotations (Google's wmt-mqm-human-evaluation). The TED
// text is CC BY-NC-ND, so it stays in data/raw: items are rebuilt from the
// pinned file each run, and results record only IDs and numbers.

import { createHash } from 'node:crypto';

/** One annotated error (or a No-error row) from the TSV. */
interface MqmRow {
  system: string;
  segId: string;
  source: string;
  target: string;
  category: string;
  severity: string;
}

export interface MqmSpan {
  severity: 'major' | 'minor';
  category: string;
  /** In the plain (untagged) target, or null for an error marked in the source. */
  targetStart: number | null;
  targetEnd: number | null;
  /** In the plain source, for errors marked there (omissions). */
  sourceStart: number | null;
  sourceEnd: number | null;
}

export interface CalibrationItem {
  /** `system/segId`, stable across runs. */
  id: string;
  source: string;
  /** The reference translation (the `ref` system), untagged. */
  reference: string;
  /** The rated translation, untagged. */
  translation: string;
  /** MQM penalty: major 5, minor 1, minor punctuation 0.1, non-translation 25. */
  penalty: number;
  errors: MqmSpan[];
}

const strip = (text: string) => text.replace(/<\/?v>/g, '');

/** Offsets of the <v>…</v> span in the untagged text, or null if none. */
function span(text: string): [number, number] | null {
  const start = text.indexOf('<v>');
  const end = text.indexOf('</v>');
  if (start < 0 || end < start) return null;
  return [start, end - 3];
}

export function parseMqm(tsv: string): MqmRow[] {
  const [header, ...lines] = tsv.split('\n').filter((l) => l.trim());
  const columns = header!.split('\t');
  const at = (name: string) => columns.indexOf(name);
  return lines.map((line) => {
    const f = line.split('\t');
    return {
      system: f[at('system')]!,
      segId: f[at('seg_id')]!,
      source: f[at('source')]!,
      target: f[at('target')]!,
      category: f[at('category')]!,
      severity: f[at('severity')]!,
    };
  });
}

function penaltyOf(row: MqmRow): number {
  if (row.category === 'No-error' || row.category === 'Source error') return 0;
  if (row.category.startsWith('Non-translation')) return 25;
  if (row.severity === 'Major') return 5;
  if (row.severity === 'Minor') {
    return row.category === 'Fluency/Punctuation' ? 0.1 : 1;
  }
  return 0;
}

/** Every rated translation (not the references), with its errors. */
export function mqmItems(rows: readonly MqmRow[]): CalibrationItem[] {
  const references = new Map<string, string>();
  for (const row of rows) {
    if (row.system === 'ref') references.set(row.segId, strip(row.target));
  }
  const items = new Map<string, CalibrationItem>();
  for (const row of rows) {
    if (row.system === 'ref' || row.system === 'refB') continue;
    const reference = references.get(row.segId);
    if (!reference) continue;
    const id = `${row.system}/${row.segId}`;
    let item = items.get(id);
    if (!item) {
      item = {
        id,
        source: strip(row.source),
        reference,
        translation: strip(row.target),
        penalty: 0,
        errors: [],
      };
      items.set(id, item);
    }
    const penalty = penaltyOf(row);
    item.penalty += penalty;
    if (penalty > 0 && (row.severity === 'Major' || row.severity === 'Minor')) {
      const target = span(row.target);
      const source = span(row.source);
      item.errors.push({
        severity: row.severity === 'Major' ? 'major' : 'minor',
        category: row.category,
        targetStart: target?.[0] ?? null,
        targetEnd: target?.[1] ?? null,
        sourceStart: source?.[0] ?? null,
        sourceEnd: source?.[1] ?? null,
      });
    }
  }
  for (const item of items.values()) {
    item.penalty = Math.round(item.penalty * 10) / 10;
  }
  return [...items.values()];
}

/** Penalty bands the sample is stratified over. */
export const BANDS: [number, number][] = [
  [0, 0],
  [0.1, 4.9],
  [5, 9.9],
  [10, Infinity],
];

const order = (id: string) => createHash('sha256').update(id).digest('hex');

/**
 * A fixed sample: `perBand` items from each penalty band, one per source
 * segment, among segments of learner-like length. Deterministic, so every
 * run grades the same items.
 */
export function calibrationSample(
  items: readonly CalibrationItem[],
  perBand = 10,
): CalibrationItem[] {
  const usable = items
    .filter((i) => {
      const length = [...i.source].length;
      return length >= 12 && length <= 80 && i.translation.trim();
    })
    .sort((a, b) => order(a.id).localeCompare(order(b.id)));
  const sample: CalibrationItem[] = [];
  const segments = new Set<string>();
  for (const [min, max] of BANDS) {
    let n = 0;
    for (const item of usable) {
      if (n >= perBand) break;
      const segment = item.id.split('/')[1]!;
      if (item.penalty < min || item.penalty > max || segments.has(segment))
        continue;
      sample.push(item);
      segments.add(segment);
      n++;
    }
  }
  return sample;
}
