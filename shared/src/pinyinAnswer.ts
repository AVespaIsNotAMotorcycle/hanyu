// Typed pinyin answers: live tone-number conversion for the answer field, and
// grading against a word's citation reading.

import { normalizeUmlaut, numberedToMarked } from './pinyin.js';

// Every toneless Mandarin syllable that CC-CEDICT uses, plus the syllabic
// nasals n/ng (嗯). Erhua "r" is handled separately.
const SYLLABLES = `a ai an ang ao ba bai ban bang bao bei ben beng bi bia bian
biang biao bie bin bing biu bo bu ca cai can cang cao ce cen ceng cha chai chan
chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun
chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia
dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang
fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng ging gong gou gu
gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hm hng hong
hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong
jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai
kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao
lie lin ling liu lo long lou lu lü luan lüe lun luo m ma mai man mang mao me mei
men meng mi mian miao mie min ming miu mo mou mu n na nai nan nang nao ne nei
nen neng ng ni nian niang niao nie nin ning niu nong nou nu nü nuan nüe nun nuo
o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia
qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng
ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sei sen seng sha shai
shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui
shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti
tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo
wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao
ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng
zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan
zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo`;

export const PINYIN_SYLLABLES: ReadonlySet<string> = new Set(
  SYLLABLES.split(/\s+/),
);

/** A syllable, or a syllable with an erhua r (哪儿 nǎr). */
function isSyllable(toneless: string): boolean {
  return (
    PINYIN_SYLLABLES.has(toneless) ||
    (toneless.length > 1 &&
      toneless.endsWith('r') &&
      toneless !== 'er' &&
      PINYIN_SYLLABLES.has(toneless.slice(0, -1)))
  );
}

const TONE_MARK = /[̄́̌̀]/;
const DIAERESIS = '̈';
const LETTER = /[a-zü]/;

/** Lowercase, toneless, ü-normalized form of a run of letters. */
function toneless(text: string): string {
  return normalizeUmlaut(text)
    .normalize('NFD')
    .replace(/[̄́̌̀]/g, '')
    .normalize('NFC')
    .toLowerCase();
}

function isPinyinLetter(char: string): boolean {
  return LETTER.test(toneless(char));
}

/**
 * Converts tone numbers to tone marks as the learner types: `xue2sheng5`
 * becomes `xuésheng`, `lv4` becomes `lǜ`, and typing a digit after an already
 * marked syllable re-tones it (`xué3` → `xuě`). Run-together input is split
 * at the longest valid syllable before each digit. Returns the new text and
 * where the caret moves (pass the caret position before conversion).
 */
export function convertToneNumbers(
  text: string,
  caret: number = text.length,
): { text: string; caret: number } {
  const convert = (input: string) => {
    let out = '';
    for (const char of normalizeUmlaut(input.normalize('NFC'))) {
      if (!/[0-5]/.test(char)) {
        out += char;
        continue;
      }
      // The longest valid syllable before the digit, preferring one after
      // the last tone mark (xī + an1 → xī'ān, not xiān); failing that, one
      // that is already marked, to re-tone it (xué3 → xuě).
      const letters = [...out];
      let start = letters.length;
      while (start > 0 && isPinyinLetter(letters[start - 1]!)) start--;
      let unmarked = start;
      for (let i = start; i < letters.length; i++) {
        if (TONE_MARK.test(letters[i]!.normalize('NFD'))) unmarked = i + 1;
      }
      let syllable: string | undefined;
      for (const from of [unmarked, start]) {
        for (let i = from; i < letters.length && !syllable; i++) {
          const candidate = letters.slice(i).join('');
          const bare = toneless(candidate);
          // An r right after a marked syllable is its erhua (nǎ + r5 → nǎr).
          const erhua = from === unmarked && unmarked > start && bare === 'r';
          if (isSyllable(bare) || erhua) {
            syllable = candidate;
            start = i;
          }
        }
      }
      if (syllable === undefined) {
        out += char; // not after a syllable: leave the digit alone
        continue;
      }
      const tone = char === '0' ? 5 : Number(char);
      const bare = letters.slice(0, start).join('');
      // Keep the learner's capitalization; strip any earlier tone mark.
      const plain = syllable
        .normalize('NFD')
        .replace(/[̄́̌̀]/g, '')
        .normalize('NFC');
      out = bare + numberedToMarked(`${plain}${tone}`);
    }
    return out;
  };
  const converted = convert(text);
  return {
    text: converted,
    caret: Math.min(convert(text.slice(0, caret)).length, converted.length),
  };
}

// --- Grading ------------------------------------------------------------------

interface Unit {
  /** Toneless letters, erhua r included. */
  letters: string;
  tone: number;
  /** Characters it spans: 2 for an erhua unit (哪儿), else 1. */
  span: number;
}

/** Splits a numbered reading (`na3 r5`) into units, merging erhua r5. */
function readingUnits(reading: string): Unit[] {
  const units: Unit[] = [];
  for (const syllable of reading.trim().split(/\s+/)) {
    const match = /^([a-zü]+)([1-5])$/.exec(normalizeUmlaut(syllable));
    if (!match) throw new Error(`Invalid numbered pinyin: ${reading}`);
    const [, letters, tone] = match as unknown as [string, string, string];
    const last = units.at(-1);
    if (letters === 'r' && tone === '5' && last) {
      last.letters += 'r';
      last.span += 1;
    } else {
      units.push({ letters, tone: Number(tone), span: 1 });
    }
  }
  return units;
}

/** Display form of a numbered reading: `xue2 sheng5` → `xuésheng`, with apostrophes (`xī'ān`). */
export function displayPinyin(reading: string): string {
  return readingUnits(reading)
    .map((unit, i) => {
      const marked = numberedToMarked(`${unit.letters}${unit.tone}`);
      return i > 0 && /^[aoe]/.test(unit.letters) ? `'${marked}` : marked;
    })
    .join('');
}

interface ParsedAnswer {
  letters: string;
  /** Tones the learner gave, by the index of the letter they belong to. */
  tones: { at: number; tone: number }[];
}

/**
 * Reads tone marks and tone numbers out of an answer. Spaces, hyphens,
 * apostrophes, and middle dots are ignored. Returns null on characters that
 * can't be pinyin.
 */
function parseAnswer(answer: string): ParsedAnswer | null {
  const text = normalizeUmlaut(answer.normalize('NFC'))
    .toLowerCase()
    .replace(/ɑ/g, 'a')
    .replace(/ɡ/g, 'g')
    .normalize('NFD');
  let letters = '';
  const tones: ParsedAnswer['tones'] = [];
  for (const char of text) {
    if (char === DIAERESIS && letters.endsWith('u')) {
      letters = `${letters.slice(0, -1)}ü`;
    } else if (TONE_MARK.test(char) && letters) {
      tones.push({ at: letters.length - 1, tone: '̄́̌̀'.indexOf(char) + 1 });
    } else if (/[0-5]/.test(char) && letters) {
      tones.push({
        at: letters.length - 1,
        tone: char === '0' ? 5 : Number(char),
      });
    } else if (/[a-z]/.test(char)) {
      letters += char;
    } else if (!/[\s\-'’·]/.test(char)) {
      return null;
    }
  }
  return { letters, tones };
}

export type PinyinVerdict = 'correct' | 'tone' | 'wrong';

export interface SyllableGrade {
  /** The expected syllable with its tone mark (`xué`, `nǎr`). */
  expected: string;
  expectedTone: number;
  /** The tone the learner gave: 1–4, 5 for none or neutral, null if they gave conflicting tones. */
  givenTone: number | null;
  correct: boolean;
  /**
   * The wrong tone is the tone-sandhi pronunciation (你好 ní hǎo, 一个 yí gè,
   * 不是 bú shì), which is how it's said but not the citation tone.
   */
  sandhi: boolean;
}

export interface PinyinGrade {
  /**
   * `correct`: right syllables and tones. `tone`: right syllables, a wrong or
   * missing tone. `wrong`: wrong syllables (or nothing pinyin-like).
   */
  verdict: PinyinVerdict;
  /** The reading graded against (the citation reading or an alternate). */
  reading: string;
  /** Per-syllable results; empty when the verdict is `wrong`. */
  syllables: SyllableGrade[];
}

function gradeReading(
  parsed: ParsedAnswer,
  reading: string,
  hanzi: readonly string[] | null,
): PinyinGrade {
  const units = readingUnits(reading);
  const wrong: PinyinGrade = { verdict: 'wrong', reading, syllables: [] };
  if (parsed.letters !== units.map((u) => u.letters).join('')) return wrong;

  // Which unit each letter belongs to.
  const unitOf: number[] = [];
  units.forEach((unit, i) => {
    for (const _ of unit.letters) unitOf.push(i);
  });
  const given = units.map(() => new Set<number>());
  for (const { at, tone } of parsed.tones) given[unitOf[at]!]!.add(tone);

  // The character each unit starts with, when the word's characters line up.
  let offset = 0;
  const starts = units.map((u) => (offset += u.span) - u.span);
  const chars = hanzi?.length === offset ? starts.map((at) => hanzi[at]) : [];

  const syllables = units.map((unit, i): SyllableGrade => {
    const full = [...given[i]!].filter((t) => t !== 5);
    const givenTone = full.length > 1 ? null : (full[0] ?? 5);
    // Neutral-tone syllables are lenient: dictionaries and speakers differ on
    // many of them (朋友 péngyou/péngyǒu), so any tone is accepted.
    const correct = unit.tone === 5 || givenTone === unit.tone;
    const next = units[i + 1];
    const sandhi =
      !correct &&
      ((unit.tone === 3 && givenTone === 2 && next?.tone === 3) ||
        (chars[i] === '一' && (givenTone === 2 || givenTone === 4)) ||
        (chars[i] === '不' && givenTone === 2));
    return {
      expected: numberedToMarked(`${unit.letters}${unit.tone}`),
      expectedTone: unit.tone,
      givenTone,
      correct,
      sandhi,
    };
  });
  return {
    verdict: syllables.every((s) => s.correct) ? 'correct' : 'tone',
    reading,
    syllables,
  };
}

/**
 * Grades a typed answer against a word's readings: the citation reading
 * first, then any alternates (谁 shéi/shuí). Tone marks and tone numbers are
 * both accepted, in any mix; spacing doesn't matter, and neutral tones may
 * be left unmarked (or marked 5 or 0). Tones are graded against citation
 * tones, so sandhi forms count as tone errors (flagged `sandhi`).
 *
 * Pass the word's characters (`hanzi`) to recognize 一/不 sandhi.
 */
export function gradePinyin(
  answer: string,
  readings: readonly string[],
  hanzi?: string,
): PinyinGrade {
  if (readings.length === 0) throw new Error('No readings to grade against');
  const parsed = parseAnswer(answer);
  const chars = hanzi ? [...hanzi] : null;
  const grades = readings.map((reading) =>
    parsed && parsed.letters
      ? gradeReading(parsed, reading, chars)
      : { verdict: 'wrong' as const, reading, syllables: [] },
  );
  const rank = (g: PinyinGrade) =>
    g.verdict === 'correct'
      ? 0
      : g.verdict === 'tone'
        ? 1 + g.syllables.filter((s) => !s.correct).length / 100
        : 2;
  return grades.reduce((best, g) => (rank(g) < rank(best) ? g : best));
}
