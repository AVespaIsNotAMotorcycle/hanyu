import { describe, expect, it } from 'vitest';
import {
  errorPenalty,
  findSpan,
  gradeTranslation,
  GRADER_MODEL,
  GraderError,
  overallScore,
  parseGraderReply,
} from './grading.js';
import type { JsonCall, JsonLlm } from './llm.js';

const input = {
  source: '我昨天买了两本书。',
  reference: 'I bought two books yesterday.',
  translation: 'I buy two  books today.',
};

const reply = () => ({
  scores: {
    accuracy: { score: 2, comment: 'Wrong day.' },
    completeness: { score: 5, comment: '' },
    grammar: { score: 7, comment: 'Clamped.' },
    naturalness: { score: 4.4, comment: '' },
  },
  errors: [
    {
      criterion: 'accuracy' as const,
      severity: 'major' as const,
      translationSpan: 'today',
      sourceSpan: '昨天',
      explanation: '昨天 is yesterday.',
      suggestion: 'yesterday',
    },
    {
      criterion: 'grammar' as const,
      severity: 'minor' as const,
      translationSpan: 'TWO BOOKS',
      sourceSpan: '买了',
      explanation: '了 marks a completed action.',
      suggestion: 'bought',
    },
    {
      criterion: 'naturalness' as const,
      severity: 'minor' as const,
      translationSpan: 'not in the text',
      sourceSpan: '',
      explanation: '',
      suggestion: '',
    },
  ],
  mistranslatedWords: ['昨天', '昨天', '今天', ' 了 '],
  summary: 'Close!',
});

describe('parseGraderReply', () => {
  it('clamps scores, locates spans, and keeps only source words', () => {
    const result = parseGraderReply(reply(), input);
    expect(Object.values(result.scores).map((s) => s.score)).toEqual([
      2, 5, 5, 4,
    ]);
    expect(
      result.errors.map((e) => [e.translationStart, e.sourceStart]),
    ).toEqual([
      [17, 1],
      // Not verbatim: the learner's text has two spaces.
      [null, 3],
      [null, null],
    ]);
    expect(result.mistranslatedWords).toEqual(['昨天', '了']);
    expect(overallScore(result)).toBe(4);
    expect(errorPenalty(result.errors)).toBe(7);
  });

  it('rejects a reply without every score', () => {
    const bad = reply();
    delete (bad.scores as Partial<typeof bad.scores>).naturalness;
    expect(() => parseGraderReply(bad, input)).toThrow(/naturalness/);
  });
});

describe('findSpan', () => {
  it('matches exactly, then ignoring case and outer spaces', () => {
    expect(findSpan('I buy two books.', 'two')).toBe(6);
    expect(findSpan('I buy two books.', ' TWO ')).toBe(6);
    expect(findSpan('I buy two books.', '')).toBeNull();
    expect(findSpan('I buy two books.', 'three')).toBeNull();
  });
});

describe('gradeTranslation', () => {
  const llm = (text: string, calls: JsonCall[] = []): JsonLlm => ({
    async create(params) {
      calls.push(params);
      return {
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1000, output_tokens: 500 },
        stop_reason: 'end_turn',
      };
    },
  });

  it('sends the source, reference, and translation, and prices the call', async () => {
    const calls: JsonCall[] = [];
    const out = await gradeTranslation(
      input,
      llm(JSON.stringify(reply()), calls),
    );
    expect(calls[0]!.model).toBe(GRADER_MODEL);
    expect(calls[0]!.messages[0]!.content).toContain(input.source);
    expect(calls[0]!.messages[0]!.content).toContain(input.reference);
    expect(calls[0]!.output_config.format.type).toBe('json_schema');
    expect(out.costUsd).toBeCloseTo(0.007);
    expect(out.result.summary).toBe('Close!');
  });

  it('reports a cut-off reply with its cost', async () => {
    const err = await gradeTranslation(input, llm('{"scores":')).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GraderError);
    expect((err as GraderError).costUsd).toBeCloseTo(0.007);
  });
});
