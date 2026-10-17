// Every input to the seed dataset. Sources are pinned to a commit, and their
// SHA-256 hashes live in data/sources.lock.json so rebuilds are reproducible.
// CC-CEDICT is the exception: MDBG only serves the latest export, so it is
// unpinned and its hash is recorded in the seed manifest instead.

export interface Source {
  id: string;
  /** File name under data/raw. */
  file: string;
  url: string;
  /** False for sources that change upstream and can't be locked. */
  pinned: boolean;
  license: string;
  /** False for sources the seed doesn't use (left out of its manifest). */
  seed?: false;
}

const HSK_WORDS_COMMIT = '6859875bf3ba3b7209dee3b23171f893f7493776';
const HSK_LISTS_COMMIT = '182692ce5a11bc30bdc771835d2f0f27491c25de';
const MMAH_COMMIT = 'bddc96d41bef78427ed0e034e9f7e31d71fd1b92';
const WORDFREQ_COMMIT = '912caf64b657478d1dff1138efdc078947d54bb1';
const MQM_COMMIT = '29acd6999aaea3586378c9dcb58d8cc4820cede3';

const github = (repo: string, commit: string, file: string) =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;

const HSK_SYLLABUS =
  'HSK 3.0 syllabus (新版HSK考试大纲, CLEC/CTI, Nov 2025); reference data, not republished';

// HSK 3.0 level files in krmanik/HSK-3.0, keyed by the level label used there.
const LEVELS = ['1', '2', '3', '4', '5', '6', '7-9'] as const;
const WRITE_LEVELS = ['1-2', '3', '4', '5', '6', '7-9'] as const;

export const sources: Source[] = [
  {
    // Official syllabus PDF. Not parsed (copying is disabled); kept to verify
    // the transcriptions below against rendered pages.
    id: 'hsk-syllabus-pdf',
    file: 'hsk-syllabus.pdf',
    url: 'https://hsk.cn-bj.ufileos.com/3.0/%E6%96%B0%E7%89%88HSK%E8%80%83%E8%AF%95%E5%A4%A7%E7%BA%B21219.pdf',
    pinned: true,
    license: HSK_SYLLABUS,
  },
  {
    id: 'hsk-words',
    file: 'hsk-words.csv',
    url: github(
      'uranbekanarbaev/hsk-3.0-vocabulary-dataset',
      HSK_WORDS_COMMIT,
      'data/hsk-3.0-all.csv',
    ),
    pinned: true,
    license: HSK_SYLLABUS,
  },
  ...LEVELS.map((level) => ({
    id: `hsk-grammar-${level}`,
    file: `hsk-grammar-${level}.json`,
    url: github(
      'krmanik/HSK-3.0',
      HSK_LISTS_COMMIT,
      `New HSK (2025)/HSK Grammar/json/HSK ${level}.json`,
    ),
    pinned: true,
    license: HSK_SYLLABUS,
  })),
  ...LEVELS.map((level) => ({
    id: `hsk-hanzi-${level}`,
    file: `hsk-hanzi-${level}.txt`,
    url: github(
      'krmanik/HSK-3.0',
      HSK_LISTS_COMMIT,
      `New HSK (2025)/HSK Hanzi/HSK_Level_${level}_hanzi.txt`,
    ),
    pinned: true,
    license: HSK_SYLLABUS,
  })),
  ...WRITE_LEVELS.map((level) => ({
    id: `hsk-handwritten-${level}`,
    file: `hsk-handwritten-${level}.txt`,
    url: github(
      'krmanik/HSK-3.0',
      HSK_LISTS_COMMIT,
      `New HSK (2025)/HSK Handwritten/HSK_Level_${level}_handwritten.txt`,
    ),
    pinned: true,
    license: HSK_SYLLABUS,
  })),
  {
    id: 'cc-cedict',
    file: 'cedict.txt.gz',
    url: 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
    pinned: false,
    license: 'CC BY-SA 4.0',
  },
  {
    id: 'mmah-dictionary',
    file: 'mmah-dictionary.txt',
    url: github('skishore/makemeahanzi', MMAH_COMMIT, 'dictionary.txt'),
    pinned: true,
    license: 'LGPL-3.0-or-later',
  },
  {
    id: 'mmah-graphics',
    file: 'mmah-graphics.txt',
    url: github('skishore/makemeahanzi', MMAH_COMMIT, 'graphics.txt'),
    pinned: true,
    license: 'Arphic Public License',
  },
  {
    id: 'wordfreq-zh',
    file: 'wordfreq-large_zh.msgpack.gz',
    url: github(
      'rspeer/wordfreq',
      WORDFREQ_COMMIT,
      'wordfreq/data/large_zh.msgpack.gz',
    ),
    pinned: true,
    license: 'CC BY-SA 4.0 (includes SUBTLEX-CH, credit its authors)',
  },
  {
    // Expert MQM error annotations of Chinese → English translations of TED
    // talks: the translation grader's calibration set. Not part of the seed;
    // the eval reads it from data/raw and never commits its text.
    id: 'mqm-ted-zhen',
    file: 'mqm-ted-zhen.tsv',
    url: github(
      'google/wmt-mqm-human-evaluation',
      MQM_COMMIT,
      'ted/zhen/mqm_ted_zhen.tsv',
    ),
    pinned: true,
    license:
      'Annotations Apache-2.0 (Google); TED talk text CC BY-NC-ND 4.0, not republished',
    seed: false,
  },
];

/** License texts copied into data/seed/LICENSES. */
export const licenseFiles = [
  {
    file: 'CC-BY-SA-4.0.txt',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt',
  },
  {
    file: 'ARPHICPL.txt',
    url: github(
      'skishore/makemeahanzi',
      MMAH_COMMIT,
      'APL/english/ARPHICPL.TXT',
    ),
  },
  {
    file: 'MAKEMEAHANZI-LGPL.txt',
    url: github('skishore/makemeahanzi', MMAH_COMMIT, 'LGPL'),
  },
  {
    file: 'MAKEMEAHANZI-COPYING.txt',
    url: github('skishore/makemeahanzi', MMAH_COMMIT, 'COPYING'),
  },
];

export function sourceById(id: string): Source {
  const source = sources.find((s) => s.id === id);
  if (!source) throw new Error(`Unknown source: ${id}`);
  return source;
}
