import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  englishProblem,
  readEnglish,
  translateGrammar,
  withEnglish,
  writeEnglish,
  type GrammarEnglish,
} from '../src/grammar/english.js';
import type { SyllabusGrammarPoint } from '../src/parse/grammar.js';
import type { Llm } from '../src/passages/llm.js';

const point = (
  _id: string,
  content = '非常、很1、太',
): SyllabusGrammarPoint => ({
  _id,
  level: 1,
  order: 1,
  category: '词类',
  name: '副词',
  item: '程度副词',
  content,
});

const good: GrammarEnglish = {
  title: 'Degree adverbs',
  explanation:
    'Words that say how much: 非常 (fēicháng, extremely), 很 (hěn, very), and 太 (tài, too).',
};

const usage = {
  input_tokens: 1000,
  output_tokens: 1000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const llmReplying = (text: string): Llm => ({
  create: async () =>
    ({
      content: [{ type: 'text', text }],
      usage,
      stop_reason: 'end_turn',
    }) as unknown as Awaited<ReturnType<Llm['create']>>,
});

describe('englishProblem', () => {
  it('accepts English that covers the listed forms', () => {
    expect(englishProblem(point('g1-001'), good)).toBeNull();
  });

  it('rejects Chinese and missing forms', () => {
    expect(
      englishProblem(point('g1-001'), {
        title: '程度副词',
        explanation: '表示程度：非常、很、太',
      }),
    ).toBe('not mostly English');
    expect(
      englishProblem(point('g1-001'), {
        title: 'Degree adverbs',
        explanation: 'Words like 很 (hěn, very) say how much.',
      }),
    ).toBe("doesn't cover 非常、太");
  });

  it('only checks forms in plain lists', () => {
    const pattern = point('g4-057', '（3）主语+把+宾语+动词');
    expect(
      englishProblem(pattern, {
        title: 'The 把 construction',
        explanation: 'Subject + 把 (bǎ) + object + verb: what is done to it.',
      }),
    ).toBeNull();
    const description = point('g1-035', '名词、代词或名词性短语作主语');
    expect(englishProblem(description, good)).toBeNull();
  });
});

describe('translateGrammar', () => {
  it('keeps good entries and reports the rest', async () => {
    const reply = JSON.stringify({
      points: [
        { id: 'g1-001', ...good },
        { id: 'g1-002', title: '', explanation: '' },
      ],
    });
    const result = await translateGrammar(
      [point('g1-001'), point('g1-002'), point('g1-003')],
      llmReplying(reply),
    );
    expect(result.english).toEqual({ 'g1-001': good });
    expect(result.problems).toEqual([
      { id: 'g1-002', problem: 'empty title or explanation' },
      { id: 'g1-003', problem: 'not in the reply' },
    ]);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('reports every point when the reply is cut off', async () => {
    const result = await translateGrammar(
      [point('g1-001')],
      llmReplying('{"points": [{"id'),
    );
    expect(result.english).toEqual({});
    expect(result.problems).toHaveLength(1);
  });
});

describe('the English file', () => {
  const file = () =>
    path.join(mkdtempSync(path.join(tmpdir(), 'grammar-')), 'english.json');

  it('round-trips, sorted by ID', () => {
    const target = file();
    writeEnglish(
      {
        model: 'm',
        promptVersion: 1,
        points: { 'g1-002': good, 'g1-001': good },
      },
      target,
    );
    expect(Object.keys(readEnglish(target).points)).toEqual([
      'g1-001',
      'g1-002',
    ]);
  });

  it('starts empty', () => {
    expect(readEnglish(file()).points).toEqual({});
  });
});

describe('withEnglish', () => {
  const english = { model: 'm', promptVersion: 1, points: { 'g1-001': good } };

  it('adds the English to each point', () => {
    expect(withEnglish([point('g1-001')], english)).toEqual([
      { ...point('g1-001'), ...good },
    ]);
  });

  it('fails when a point has none', () => {
    expect(() => withEnglish([point('g1-002')], english)).toThrow(/g1-002/);
  });
});
