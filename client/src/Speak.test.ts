import { describe, expect, it } from 'vitest';
import { mandarinVoices, pickChineseVoice, sentences } from './Speak';

const voice = (name: string, lang: string, localService = true) =>
  ({ name, lang, localService, voiceURI: name }) as SpeechSynthesisVoice;

describe('pickChineseVoice', () => {
  it('prefers mainland Mandarin, then local voices', () => {
    const voices = [
      voice('English', 'en-US'),
      voice('Sinji', 'zh-HK'),
      voice('Meijia', 'zh-TW'),
      voice('Google 普通话', 'zh-CN', false),
      voice('Tingting', 'zh_CN'),
    ];
    expect(pickChineseVoice(voices)?.name).toBe('Tingting');
    expect(pickChineseVoice(voices.slice(0, 3))?.name).toBe('Meijia');
    expect(mandarinVoices(voices).map((v) => v.name)).toEqual([
      'Tingting',
      'Google 普通话',
      'Meijia',
    ]);
  });

  it('uses the chosen voice while the device still has it', () => {
    const voices = [voice('Tingting', 'zh-CN'), voice('Meijia', 'zh-TW')];
    expect(pickChineseVoice(voices, 'Meijia')?.name).toBe('Meijia');
    expect(pickChineseVoice(voices, 'Gone')?.name).toBe('Tingting');
    // A Cantonese voice can't be chosen.
    expect(
      pickChineseVoice([...voices, voice('Sinji', 'zh-HK')], 'Sinji')?.name,
    ).toBe('Tingting');
  });

  it('never picks Cantonese or a non-Chinese voice', () => {
    expect(
      pickChineseVoice([voice('Sinji', 'zh-HK'), voice('Yue', 'yue-HK')]),
    ).toBeNull();
    expect(pickChineseVoice([voice('English', 'en-US')])).toBeNull();
  });
});

describe('sentences', () => {
  it('splits after sentence marks and line breaks, keeping quotes', () => {
    expect(sentences('标题\n他说：“你好！”我很好。好吗')).toEqual([
      '标题',
      '他说：“你好！”',
      '我很好。',
      '好吗',
    ]);
    expect(sentences('你好')).toEqual(['你好']);
  });
});
