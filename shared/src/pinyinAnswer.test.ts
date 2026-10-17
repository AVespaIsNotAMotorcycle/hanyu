import { describe, expect, it } from 'vitest';
import {
  convertToneNumbers,
  displayPinyin,
  gradePinyin,
  type PinyinGrade,
} from './pinyinAnswer.js';

const convert = (text: string) => convertToneNumbers(text).text;

describe('convertToneNumbers', () => {
  it.each([
    ['xue2sheng5', 'xuésheng'],
    ['xue2 sheng', 'xué sheng'],
    ['Zhong1guo2', 'Zhōngguó'],
    ['lv4', 'lǜ'],
    ['nu:3', 'nǚ'],
    ['nar3', 'nǎr'],
    ['na3r', 'nǎr'],
    ['na3r5', 'nǎr'],
    ['xi1an1', 'xīān'],
    ['xuésheng5', 'xuésheng'],
    ['ni3hao3', 'nǐhǎo'],
    ['hao3wan2r', 'hǎowánr'],
    ['ng4', 'ǹg'],
    ['xue0', 'xue'],
  ])('%s → %s', (input, output) => {
    expect(convert(input)).toBe(output);
  });

  it('re-tones a syllable when another digit follows it', () => {
    expect(convert('xué3')).toBe('xuě');
    expect(convert('xué5')).toBe('xue');
  });

  it('leaves digits alone when no syllable precedes them', () => {
    expect(convert('3')).toBe('3');
    expect(convert('qq3')).toBe('qq3');
    expect(convert('a 4')).toBe('a 4');
  });

  it('moves the caret past removed digits', () => {
    expect(convertToneNumbers('xue2sheng', 4)).toEqual({
      text: 'xuésheng',
      caret: 3,
    });
    expect(convertToneNumbers('xue2sheng5', 10).caret).toBe(8);
  });
});

describe('displayPinyin', () => {
  it('joins syllables with apostrophes where needed and merges erhua', () => {
    expect(displayPinyin('xue2 sheng5')).toBe('xuésheng');
    expect(displayPinyin('xi1 an1')).toBe("xī'ān");
    expect(displayPinyin('na3 r5')).toBe('nǎr');
  });
});

function summary({ verdict, syllables }: PinyinGrade) {
  return {
    verdict,
    wrong: syllables.filter((s) => !s.correct).map((s) => s.expected),
    sandhi: syllables.filter((s) => s.sandhi).map((s) => s.expected),
  };
}

describe('gradePinyin', () => {
  it.each([
    ['xue2sheng5'],
    ['xue2sheng'],
    ['xue2 sheng'],
    ['xué shēng'], // any tone is accepted on a neutral syllable
    ['xuésheng'],
    ['Xue2-sheng0'],
    ['xué sheng5'],
  ])('accepts %s for xue2 sheng5', (answer) => {
    expect(gradePinyin(answer, ['xue2 sheng5']).verdict).toBe('correct');
  });

  it('flags missing and wrong tones as tone errors', () => {
    expect(summary(gradePinyin('xuesheng', ['xue2 sheng5']))).toEqual({
      verdict: 'tone',
      wrong: ['xué'],
      sandhi: [],
    });
    expect(summary(gradePinyin('lao3shi3', ['lao3 shi1']))).toEqual({
      verdict: 'tone',
      wrong: ['shī'],
      sandhi: [],
    });
  });

  it('marks wrong syllables wrong', () => {
    for (const answer of ['xue2shen', 'xue2sheng5ren2', '学生', '', '   ']) {
      expect(gradePinyin(answer, ['xue2 sheng5']).verdict).toBe('wrong');
    }
  });

  it('grades against citation tones and recognizes sandhi', () => {
    expect(summary(gradePinyin('ni2hao3', ['ni3 hao3'], '你好'))).toEqual({
      verdict: 'tone',
      wrong: ['nǐ'],
      sandhi: ['nǐ'],
    });
    expect(summary(gradePinyin('yi2ge4', ['yi1 ge4'], '一个')).sandhi).toEqual([
      'yī',
    ]);
    expect(
      summary(gradePinyin('bu2shi4', ['bu4 shi4'], '不是')).sandhi,
    ).toEqual(['bù']);
    // yi2 for 医 is just a wrong tone.
    expect(
      summary(gradePinyin('yi2sheng1', ['yi1 sheng1'], '医生')).sandhi,
    ).toEqual([]);
  });

  it('handles erhua typed either way', () => {
    for (const answer of ['nar3', 'na3r', 'na3 r5', 'nǎr']) {
      expect(gradePinyin(answer, ['na3 r5'], '哪儿').verdict).toBe('correct');
    }
    expect(gradePinyin('na3', ['na3 r5'], '哪儿').verdict).toBe('wrong');
  });

  it('accepts alternate readings', () => {
    const grade = gradePinyin('shui2', ['shei2', 'shui2'], '谁');
    expect(grade).toMatchObject({ verdict: 'correct', reading: 'shui2' });
    expect(gradePinyin('shei3', ['shei2', 'shui2']).verdict).toBe('tone');
  });

  it('accepts ü spelled v or u:, any case, and IPA look-alikes', () => {
    for (const answer of ['lv4se4', 'LU:4 SE4', 'lǜsè', 'lü4 sè']) {
      expect(gradePinyin(answer, ['lu:4 se4']).verdict).toBe('correct');
    }
    expect(gradePinyin('ɡē', ['ge1']).verdict).toBe('correct');
  });

  it('reports conflicting tones on one syllable', () => {
    const grade = gradePinyin('xué4', ['xue2']);
    expect(grade.verdict).toBe('tone');
    expect(grade.syllables[0]!.givenTone).toBeNull();
  });

  it('handles syllabic nasals', () => {
    expect(gradePinyin('ǹg', ['ng4']).verdict).toBe('correct');
    expect(gradePinyin('ng4', ['ng4']).verdict).toBe('correct');
  });
});
