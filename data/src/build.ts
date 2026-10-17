// Builds the versioned seed dataset in data/seed from the sources in data/raw.
// Run `npm run fetch -w data` first. Output is deterministic: rebuilding from
// the same sources produces byte-identical files.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  comparablePinyin,
  normalizeUmlaut,
  numberedToMarked,
  stripTones,
  toneOf,
  type CedictMatch,
  type CharacterNote,
  type DatasetManifest,
  type GrammarPoint,
  type HskLevel,
  type WordNote,
  type WordSyllable,
} from '@hanyu/shared';
import { sha256File } from './hash.js';
import {
  citationFromSyllabus,
  composeFromParts,
  matchCedict,
} from './match.js';
import { cedictHeader, parseCedict, type CedictEntry } from './parse/cedict.js';
import { parseGrammar } from './parse/grammar.js';
import { parseCharacterList, parseHskWords, parseLevel } from './parse/hsk.js';
import { parseMmahDictionary, parseMmahGraphics } from './parse/mmah.js';
import { parseWordfreq } from './parse/wordfreq.js';
import { dataDir, rawDir, seedDir } from './paths.js';
import { createSegmenter } from './segmenter.js';
import { sourceById, sources } from './sources.js';

const raw = (id: string) => path.join(rawDir, sourceById(id).file);
const readText = (id: string) => readFile(raw(id), 'utf8');
const unique = <T>(items: Iterable<T>) => [...new Set(items)];

const { version } = JSON.parse(
  await readFile(path.join(dataDir, 'package.json'), 'utf8'),
) as {
  version: string;
};

// --- Load sources -----------------------------------------------------------

const hskWords = parseHskWords(await readText('hsk-words'));
const cedictText = gunzipSync(await readFile(raw('cc-cedict'))).toString(
  'utf8',
);
const cedict = parseCedict(cedictText);
const zipfByWord = parseWordfreq(await readFile(raw('wordfreq-zh')));

const GRAMMAR_LEVELS = ['1', '2', '3', '4', '5', '6', '7-9'];
const grammar: GrammarPoint[] = [];
for (const label of GRAMMAR_LEVELS) {
  grammar.push(
    ...parseGrammar(await readText(`hsk-grammar-${label}`), parseLevel(label)),
  );
}

async function characterLevels(
  prefix: string,
  labels: string[],
): Promise<Map<string, HskLevel>> {
  const levels = new Map<string, HskLevel>();
  for (const label of labels) {
    for (const char of parseCharacterList(
      await readText(`${prefix}-${label}`),
    )) {
      if (!levels.has(char)) levels.set(char, parseLevel(label));
    }
  }
  return levels;
}
const readLevels = await characterLevels('hsk-hanzi', GRAMMAR_LEVELS);
const writeLevels = await characterLevels('hsk-handwritten', [
  '1-2',
  '3',
  '4',
  '5',
  '6',
  '7-9',
]);

// --- Words ------------------------------------------------------------------

const segmenter = createSegmenter();

/**
 * Zipf frequency, estimated from parts when wordfreq lacks the whole word.
 * The estimate follows wordfreq's own rule for multi-token text: combine the
 * parts' frequencies as 1 / Σ(1/fᵢ), then divide by 10 per inferred word break.
 */
function zipfOf(word: string): number {
  const direct = zipfByWord.get(word);
  if (direct !== undefined) return direct;
  if (word.endsWith('儿') && zipfByWord.has(word.slice(0, -1)))
    return zipfByWord.get(word.slice(0, -1))!;
  const parts = segmenter.segment(word);
  if (parts.length < 2 || !parts.every((p) => zipfByWord.has(p))) return 0;
  const inverseSum = parts.reduce(
    (sum, p) => sum + 10 ** -(zipfByWord.get(p)! - 9),
    0,
  );
  const zipf = Math.log10(1 / inverseSum) + 9 - (parts.length - 1);
  return Math.round(zipf * 100) / 100;
}

function alignSyllables(
  simplified: string,
  traditional: string,
  pinyin: string,
): WordSyllable[] | null {
  const s = [...simplified];
  const t = [...traditional];
  const p = pinyin.split(' ');
  if (s.length !== p.length || t.length !== s.length) return null;
  return s.map((char, i) => ({
    simplified: char,
    traditional: t[i]!,
    pinyin: p[i]!,
  }));
}

const report = {
  exact: 0,
  sandhiOrToneMatch: 0,
  tonesDiffer: [] as string[],
  composed: [] as string[],
  unmatched: [] as string[],
  traditionalVariants: 0,
  unalignedSyllables: [] as string[],
  estimatedZipf: [] as string[],
  noZipf: [] as string[],
};

interface Reading {
  match: CedictMatch;
  entries: CedictEntry[];
  traditional: string;
  citationPinyin: string;
}

/** Looks up one syllabus reading in CC-CEDICT, composing from parts if needed. */
function lookUp(simplified: string, pinyin: string): Reading | null {
  const nasal = syllabicNasal(pinyin);
  if (nasal) return nasal.lookUp(simplified);
  const result = matchCedict(pinyin, cedict.get(simplified) ?? []);
  let entries = result.entries;
  if (result.match === 'none') {
    const parts = composeFromParts(simplified, pinyin, cedict);
    if (!parts) return null;
    entries = parts;
  }
  const traditional =
    result.match === 'none'
      ? entries.map((e) => e.traditional).join('')
      : entries[0]!.traditional;
  const cedictPinyin =
    result.match === 'none'
      ? entries.map((e) => e.pinyin).join(' ')
      : entries[0]!.pinyin;
  const citationPinyin =
    citationFromSyllabus(pinyin, cedictPinyin, simplified) ??
    normalizeUmlaut(cedictPinyin).toLowerCase();
  if (citationPinyin !== normalizeUmlaut(cedictPinyin).toLowerCase()) {
    report.tonesDiffer.push(
      `${simplified} ${citationPinyin} (CC-CEDICT ${cedictPinyin})`,
    );
  }
  return { match: result.match, entries, traditional, citationPinyin };
}

/**
 * CC-CEDICT spells syllabic nasals with a vowel (嗯 en4 where the syllabus
 * has ǹg). Look up the vowel spelling, but keep the syllabus reading.
 */
function syllabicNasal(pinyin: string) {
  const base = stripTones(comparablePinyin(pinyin));
  if (!/^(h?ng?|h?m)$/.test(base)) return null;
  const tone = toneOf(pinyin);
  return {
    lookUp(simplified: string): Reading | null {
      const result = matchCedict(
        numberedToMarked(`en${tone}`),
        cedict.get(simplified) ?? [],
      );
      if (result.match === 'none') return null;
      const entries = result.entries;
      return {
        match: result.match,
        entries,
        traditional: entries[0]!.traditional,
        citationPinyin: `${base}${tone}`,
      };
    },
  };
}

const words: WordNote[] = hskWords.map((row) => {
  // A few entries list alternate readings: "shéi/shuí".
  const [first, ...others] = row.pinyin.split('/');
  const reading = lookUp(row.simplified, first!);
  // CC-CEDICT often mentions an alternate only in a definition ("also pr.
  // [shui2]"), so a one-syllable alternate is converted directly.
  const alternatePinyin = others
    .map(
      (p) =>
        lookUp(row.simplified, p)?.citationPinyin ??
        ([...row.simplified].length === 1
          ? `${stripTones(comparablePinyin(p))}${toneOf(p)}`
          : undefined),
    )
    .filter((p): p is string => !!p);

  let traditional = row.simplified;
  let citationPinyin = '';
  let definitions: string[] = [];
  let traditionalVariants: string[] = [];
  const match: CedictMatch = reading?.match ?? 'none';

  if (!reading) {
    report.unmatched.push(`${row.simplified} ${row.pinyin}`);
  } else {
    traditional = reading.traditional;
    citationPinyin = reading.citationPinyin;
    if (reading.match === 'none') {
      // Built from parts: keep the forms and readings, but leave definitions
      // empty rather than guess at a gloss from the parts.
      report.composed.push(
        `${row.simplified} = ${reading.entries.map((e) => e.simplified).join(' + ')}`,
      );
    } else {
      if (reading.match === 'exact') report.exact++;
      else report.sandhiOrToneMatch++;
      traditionalVariants = unique(
        reading.entries.map((e) => e.traditional),
      ).filter((t) => t !== traditional);
      definitions = unique(
        reading.entries
          .filter((e) => e.traditional === traditional)
          .flatMap((e) => e.definitions),
      );
    }
  }
  if (traditionalVariants.length) report.traditionalVariants++;

  const syllables = citationPinyin
    ? alignSyllables(row.simplified, traditional, citationPinyin)
    : null;
  if (citationPinyin && !syllables)
    report.unalignedSyllables.push(`${row.simplified} [${citationPinyin}]`);

  const zipf = zipfOf(row.simplified);
  if (!zipfByWord.has(row.simplified)) {
    (zipf ? report.estimatedZipf : report.noZipf).push(row.simplified);
  }

  return {
    _id: `hsk30-${String(row.hskId).padStart(5, '0')}`,
    hskId: row.hskId,
    level: row.level,
    levelLabel: row.levelLabel,
    simplified: row.simplified,
    traditional,
    traditionalVariants,
    homograph: row.homograph,
    pinyin: row.pinyin,
    citationPinyin,
    alternatePinyin,
    syllables,
    partsOfSpeech: row.partsOfSpeech,
    definitions,
    zipf,
    levelOrder: 0, // assigned below
    characters: unique([...row.simplified]),
    cedictMatch: match,
  };
});

// New cards within a level are introduced most frequent first.
const introductionOrder = [...words].sort(
  (a, b) => a.level - b.level || b.zipf - a.zipf || a.hskId - b.hskId,
);
const nextInLevel = new Map<HskLevel, number>();
for (const word of introductionOrder) {
  const n = (nextInLevel.get(word.level) ?? 0) + 1;
  nextInLevel.set(word.level, n);
  word.levelOrder = n;
}

// --- Characters -------------------------------------------------------------

// A character note is introduced with the first word that contains it.
const characters = new Map<string, CharacterNote>();
for (const word of introductionOrder) {
  for (const char of word.characters) {
    if (characters.has(char)) continue;
    characters.set(char, {
      _id: char,
      traditional: [],
      readings: [],
      introLevel: word.level,
      introducedBy: word._id,
      introOrder: characters.size + 1,
      hskReadLevel: readLevels.get(char) ?? null,
      hskWriteLevel: writeLevels.get(char) ?? null,
    });
  }
}
// Readings and traditional forms come from every word, in introduction order.
for (const word of introductionOrder) {
  for (const syllable of word.syllables ?? []) {
    const note = characters.get(syllable.simplified)!;
    if (!note.traditional.includes(syllable.traditional))
      note.traditional.push(syllable.traditional);
    if (!note.readings.includes(syllable.pinyin))
      note.readings.push(syllable.pinyin);
  }
}
for (const note of characters.values()) {
  if (note.traditional.length === 0) note.traditional.push(note._id);
}

const wanted = new Set(characters.keys());
const details = parseMmahDictionary(await readText('mmah-dictionary'), wanted);
const strokes = parseMmahGraphics(await readText('mmah-graphics'), wanted);
const listedOnly = unique([...readLevels.keys(), ...writeLevels.keys()]).filter(
  (c) => !characters.has(c),
);

// --- Write ------------------------------------------------------------------

/** JSON array with one record per line, so diffs stay readable. */
async function writeRecords(
  file: string,
  records: { _id: string }[],
): Promise<string> {
  const sorted = [...records].sort((a, b) =>
    a._id < b._id ? -1 : a._id > b._id ? 1 : 0,
  );
  const body = `[\n${sorted.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;
  const target = path.join(seedDir, file);
  await writeFile(target, body);
  return target;
}

const outputs = {
  'words.json': words,
  'characters.json': [...characters.values()],
  'character-details.json': [...details.values()],
  'strokes.json': [...strokes.values()],
  'grammar.json': grammar,
};

const contentHash = createHash('sha256');
for (const [file, records] of Object.entries(outputs)) {
  contentHash
    .update(file)
    .update(await sha256File(await writeRecords(file, records)));
}

const cedictInfo = cedictHeader(cedictText);
const manifest: DatasetManifest & { contentHash: string; cedictDate: string } =
  {
    version,
    contentHash: contentHash.digest('hex'),
    cedictDate: cedictInfo.date ?? 'unknown',
    sources: await Promise.all(
      sources
        .filter((s) => s.seed !== false)
        .map(async (s) => ({
          id: s.id,
          url: s.url,
          sha256: await sha256File(raw(s.id)),
          license: s.license,
        })),
    ),
    counts: Object.fromEntries(
      Object.entries(outputs).map(([file, records]) => [file, records.length]),
    ),
  };
await writeFile(
  path.join(seedDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

// --- Report -----------------------------------------------------------------

const sample = (items: string[], n = 8) =>
  items.length
    ? ` (${items.slice(0, n).join('; ')}${items.length > n ? '; …' : ''})`
    : '';

console.log(
  `Seed dataset ${version} written to ${path.relative(process.cwd(), seedDir)}`,
);
console.log(`  words: ${words.length}`);
console.log(
  `    CC-CEDICT match: ${report.exact} exact, ${report.sandhiOrToneMatch} with different tones`,
);
console.log(
  `    citation tones differ from CC-CEDICT: ${report.tonesDiffer.length}${sample(report.tonesDiffer)}`,
);
console.log(
  `    composed from parts: ${report.composed.length}${sample(report.composed)}`,
);
console.log(
  `    unmatched: ${report.unmatched.length}${sample(report.unmatched)}`,
);
console.log(`    with traditional variants: ${report.traditionalVariants}`);
console.log(
  `    syllables not aligned: ${report.unalignedSyllables.length}${sample(report.unalignedSyllables)}`,
);
console.log(
  `    zipf estimated from parts: ${report.estimatedZipf.length}${sample(report.estimatedZipf)}`,
);
console.log(
  `    no frequency: ${report.noZipf.length}${sample(report.noZipf)}`,
);
console.log(`  characters: ${characters.size}`);
console.log(`    missing MMAH details: ${characters.size - details.size}`);
console.log(
  `    missing MMAH strokes: ${characters.size - strokes.size}${sample([...wanted].filter((c) => !strokes.has(c)))}`,
);
console.log(
  `    in syllabus character lists but no HSK word: ${listedOnly.length}${sample(listedOnly)}`,
);
console.log(`  grammar points: ${grammar.length}`);
