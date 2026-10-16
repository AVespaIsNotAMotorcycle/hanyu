import type { CharacterDetails, CharacterStrokes } from '@hanyu/shared';

interface RawDictionaryEntry {
  character: string;
  definition?: string;
  radical?: string;
  decomposition?: string;
  etymology?: CharacterDetails['etymology'];
}

interface RawGraphicsEntry {
  character: string;
  strokes: string[];
  medians: [number, number][][];
}

function* jsonLines<T>(text: string): Generator<T> {
  for (const line of text.split('\n'))
    if (line.trim()) yield JSON.parse(line) as T;
}

/** Parses Make Me a Hanzi dictionary.txt for the requested characters. */
export function parseMmahDictionary(
  text: string,
  wanted: Set<string>,
): Map<string, CharacterDetails> {
  const result = new Map<string, CharacterDetails>();
  for (const e of jsonLines<RawDictionaryEntry>(text)) {
    if (!wanted.has(e.character)) continue;
    result.set(e.character, {
      _id: e.character,
      definition: e.definition ?? null,
      radical: e.radical ?? null,
      // "？" marks an unknown component in MMAH decompositions.
      decomposition:
        e.decomposition && e.decomposition !== '？' ? e.decomposition : null,
      etymology: e.etymology ?? null,
    });
  }
  return result;
}

/** Parses Make Me a Hanzi graphics.txt for the requested characters. */
export function parseMmahGraphics(
  text: string,
  wanted: Set<string>,
): Map<string, CharacterStrokes> {
  const result = new Map<string, CharacterStrokes>();
  for (const e of jsonLines<RawGraphicsEntry>(text)) {
    if (!wanted.has(e.character)) continue;
    result.set(e.character, {
      _id: e.character,
      strokes: e.strokes,
      medians: e.medians,
    });
  }
  return result;
}
