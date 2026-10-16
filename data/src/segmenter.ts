import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';

export interface Segmenter {
  /** Splits text into words, dropping whitespace. */
  segment(text: string): string[];
}

const HANZI = /\p{Script=Han}/u;

export const isHanziToken = (token: string) => HANZI.test(token);

/**
 * Creates a jieba segmenter. Extra words (e.g. the HSK vocabulary) that are
 * missing from jieba's dictionary are added, so they come back as single
 * tokens; words jieba already knows keep their frequencies.
 */
export function createSegmenter(extraWords: Iterable<string> = []): Segmenter {
  const jieba = Jieba.withDict(dict);
  const known = new Set(
    Buffer.from(dict)
      .toString('utf8')
      .split('\n')
      .map((line) => line.split(' ', 1)[0]),
  );
  const missing = [...new Set(extraWords)].filter((w) => !known.has(w));
  if (missing.length) {
    // jieba's suggested frequency for user-dictionary words.
    jieba.loadDict(Buffer.from(missing.map((w) => `${w} 3`).join('\n')));
  }
  return {
    segment: (text) => jieba.cut(text, true).filter((t) => t.trim() !== ''),
  };
}
