// Recorded audio (Azure neural text-to-speech, generated offline by
// `npm run audio:generate`): which clips exist and what each one says.
// Client and server agree on clip keys through these functions.

import { CLOZE_BLANK, paragraphs, type Passage } from './passages.js';
import type { WordNote } from './content.js';
import type { ListeningExercise } from './listening.js';

/** Azure voice the clips are recorded with (see data/README.md to change it). */
export const AUDIO_VOICE = 'zh-CN-XiaoxiaoNeural';
export const AUDIO_LOCALE = 'zh-CN';
/** Azure's output format name, and what the server serves it as. */
export const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
export const AUDIO_MIME = 'audio/mpeg';

export interface ClipSpec {
  /** `word:hsk30-00001`, `passage:p1-0001:p0` (see audioKeys). */
  key: string;
  text: string;
  /**
   * Citation pinyin to force (`hang2`), for words whose characters have
   * another reading the voice might pick; null to let the voice choose.
   */
  pinyin: string | null;
}

/** data/audio/manifest.json: clip key → what's in clips/<hash>.mp3. */
export interface AudioManifest {
  clips: Record<string, AudioManifestEntry>;
}

export interface AudioManifestEntry {
  /** Hash of what was synthesized (voice, format, text, pinyin). */
  hash: string;
  text: string;
  pinyin: string | null;
  voice: string;
  bytes: number;
}

/** What the settings' Test button plays. */
export const AUDIO_SAMPLE = '你好！我们一起学习汉语吧。';

export const audioKeys = {
  sample: 'sample',
  word: (wordId: string) => `word:${wordId}`,
  passageTitle: (passageId: string) => `passage:${passageId}:title`,
  paragraph: (passageId: string, index: number) =>
    `passage:${passageId}:p${index}`,
  /** A choice question's prompt. */
  prompt: (passageId: string, questionId: string) =>
    `passage:${passageId}:q:${questionId}`,
  /** A cloze sentence with the answer filled in. */
  cloze: (passageId: string, questionId: string) =>
    `passage:${passageId}:c:${questionId}`,
  /** A listening exercise's text. */
  listening: (exerciseId: string) => `listening:${exerciseId}`,
  /** A listening question's prompt. */
  listeningPrompt: (exerciseId: string, questionId: string) =>
    `listening:${exerciseId}:q:${questionId}`,
};

/** A cloze sentence as read aloud: with its answer in the blank. */
export const filledCloze = (sentence: string, answer: string) =>
  sentence.replace(CLOZE_BLANK, answer);

/** Every clip a passage has: title, paragraphs, and question sentences. */
export function passageClips(passage: Passage): ClipSpec[] {
  const clip = (key: string, text: string): ClipSpec => ({
    key,
    text,
    pinyin: null,
  });
  return [
    clip(audioKeys.passageTitle(passage._id), passage.title),
    ...paragraphs(passage.text).map((text, i) =>
      clip(audioKeys.paragraph(passage._id, i), text),
    ),
    ...passage.questions.map((q) =>
      q.type === 'choice'
        ? clip(audioKeys.prompt(passage._id, q.id), q.prompt)
        : clip(
            audioKeys.cloze(passage._id, q.id),
            filledCloze(q.sentence, q.answer),
          ),
    ),
  ];
}

/** Every clip a listening exercise has: its text and question prompts. */
export function listeningClips(exercise: ListeningExercise): ClipSpec[] {
  return [
    {
      key: audioKeys.listening(exercise._id),
      text: exercise.text,
      pinyin: null,
    },
    ...exercise.questions.map((q) => ({
      key: audioKeys.listeningPrompt(exercise._id, q.id),
      text: q.prompt,
      pinyin: null,
    })),
  ];
}

/**
 * One clip per word. A word read more than one way across the word list
 * (行 xíng and háng) gets its pinyin forced, so each entry says its own
 * reading; the rest are left to the voice, which gets tone sandhi right.
 */
export function wordClips(words: readonly WordNote[]): ClipSpec[] {
  const readings = new Map<string, Set<string>>();
  for (const word of words) {
    const set = readings.get(word.simplified) ?? new Set();
    set.add(word.citationPinyin);
    readings.set(word.simplified, set);
  }
  return words.map((word) => ({
    key: audioKeys.word(word._id),
    text: word.simplified,
    pinyin:
      readings.get(word.simplified)!.size > 1 ? word.citationPinyin : null,
  }));
}

/**
 * Citation pinyin (`nü3 er2`, `yi2 huir4`) in Azure's zh-CN SAPI phone set
 * (`nv 3 er 2`, `yi 2 hui r 4`): a space before each tone, ü as v, and
 * erhua's r as its own unit before the tone. Returns null if a syllable has no tone number.
 */
export function sapiPinyin(citation: string): string | null {
  const units: string[] = [];
  for (const syllable of citation.trim().toLowerCase().split(/\s+/)) {
    // The word list writes erhua as a syllable of its own (哪儿 na3 r5);
    // Azure wants it inside the syllable before, which keeps that tone.
    if (/^r[1-5]$/.test(syllable)) {
      if (!units.length) return null;
      units.splice(units.length - 1, 0, 'r');
      continue;
    }
    const match = /^([a-zü:]+?)(r?)([1-5])$/.exec(syllable);
    if (!match) return null;
    const [, base, r, tone] = match;
    // er (二) is a syllable of its own, not erhua.
    const [body, erhua] = base === 'e' && r ? ['er', ''] : [base!, r];
    units.push(body.replace(/u:|ü/g, 'v'));
    if (erhua) units.push('r');
    units.push(tone!);
  }
  return units.length ? units.join(' ') : null;
}
