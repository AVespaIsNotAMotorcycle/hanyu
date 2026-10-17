import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Passage } from '@hanyu/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSeedContent } from '../src/passages/content.js';
import {
  costOf,
  draftProblems,
  generatePassage,
  MODEL,
  PROMPT_VERSION,
  systemPrompt,
  type Llm,
} from '../src/passages/generate.js';
import {
  grammarCoverage,
  nextPassageId,
  readPassages,
  writePassage,
} from '../src/passages/library.js';
import { createSegmenter } from '../src/segmenter.js';

const content = loadSeedContent();
const segmenter = createSegmenter(content.wordLevels.keys());
const targets = content.grammar.filter((g) =>
  ['g1-001', 'g1-002'].includes(g._id),
);

/** A draft that passes every check at HSK 1. */
const goodDraft = () => ({
  title: '买东西',
  titleEnglish: 'Shopping',
  text: '小明是大学生。他有很多朋友。今天是星期六，小明和朋友们去商店买东西。\n\n商店在学校的前边。他们第一天去那个商店。小明买了一本书，朋友们买了水果。下午，他们回家了，大家都很高兴。',
  names: ['小明'],
  grammar: [
    { grammarId: 'g1-001', example: '第一天' },
    { grammarId: 'g1-002', example: '朋友们' },
  ],
  choiceQuestions: [
    {
      prompt: '小明是做什么的？',
      promptEnglish: 'What does Xiaoming do?',
      options: ['大学生', '老师', '医生', '学生'],
      answer: 0,
      explanation: 'The first sentence says he is a university student.',
    },
    {
      prompt: '他们去哪儿了？',
      promptEnglish: 'Where did they go?',
      options: ['商店', '学校', '医院', '饭店'],
      answer: 0,
      explanation: 'They went to a shop to buy things.',
    },
    {
      prompt: '小明买了什么？',
      promptEnglish: 'What did Xiaoming buy?',
      options: ['书', '水果', '茶', '米饭'],
      answer: 0,
      explanation: 'He bought a book; his friends bought fruit.',
    },
  ],
  clozeQuestions: [
    {
      sentence: '小明买了一本＿＿。',
      answer: '书',
      alsoAccepted: [],
      hint: 'book',
    },
    {
      sentence: '商店在学校的＿＿。',
      answer: '前边',
      alsoAccepted: [],
      hint: 'in front',
    },
    {
      sentence: '下午，他们＿＿了，大家都很高兴。',
      answer: '回家',
      alsoAccepted: [],
      hint: 'go home',
    },
  ],
});

const usage = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3000,
};

/**
 * A fake client that answers each call with the next draft as JSON text, the
 * way structured outputs replies. A string draft is sent as is (for
 * truncated replies).
 */
function fakeLlm(drafts: unknown[]) {
  const calls: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  const llm: Llm = {
    async create(params) {
      // The API rejects forced tool use for this model.
      expect(params).not.toHaveProperty('tool_choice');
      expect(params).not.toHaveProperty('tools');
      calls.push(structuredClone(params));
      const draft = drafts[calls.length - 1];
      const text = typeof draft === 'string' ? draft : JSON.stringify(draft);
      return {
        content: [
          {
            type: 'text',
            text,
            citations: null,
          } as Anthropic.Messages.TextBlock,
        ],
        usage: usage as Anthropic.Messages.Usage,
        stop_reason: typeof draft === 'string' ? 'max_tokens' : 'end_turn',
      };
    },
  };
  return { llm, calls };
}

/** Every object in a JSON schema, depth first. */
function objects(schema: Record<string, unknown>): Record<string, unknown>[] {
  const found = schema.type === 'object' ? [schema] : [];
  for (const child of Object.values(
    (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    found.push(...objects(child));
  }
  if (schema.items)
    found.push(...objects(schema.items as Record<string, unknown>));
  return found;
}

const check = (draft: ReturnType<typeof goodDraft>) =>
  draftProblems(draft, { level: 1, targets, content, segmenter }).problems;

describe('draftProblems', () => {
  it('passes a good draft', () => {
    expect(check(goodDraft())).toEqual([]);
  });

  it('names off-level words for the model to replace', () => {
    const draft = goodDraft();
    // Two off-level words alone would still pass (about 96%); add more.
    draft.text =
      draft.text.replace('前边', '东边').replace('回家了', '一起回家了') +
      '\n\n他们参观了博物馆，欣赏了美丽的风景。';
    draft.clozeQuestions[1]!.answer = '东边';
    draft.clozeQuestions[2]!.sentence = '下午，他们一起＿＿了，大家都很高兴。';
    const problems = check(draft);
    expect(problems.join('\n')).toMatch(/Replace these: .*博物馆/);
    expect(problems.join('\n')).toMatch(/Replace these: .*东/);
    expect(problems.join('\n')).toMatch(
      /"东边" must be a word .* from the vocabulary list/,
    );
  });

  it('checks cloze sentences against the text', () => {
    const draft = goodDraft();
    draft.clozeQuestions[0]!.sentence = '小明买了两本＿＿。';
    draft.clozeQuestions[1]!.sentence = '商店在学校的前边。';
    expect(check(draft)).toEqual([
      expect.stringMatching(/Cloze question 1: .*match the text exactly/),
      expect.stringMatching(/Cloze question 2 must contain exactly one ＿＿/),
    ]);
  });

  it('requires every target grammar point, quoted from the text', () => {
    const draft = goodDraft();
    draft.grammar = [{ grammarId: 'g1-001', example: '第二天' }];
    expect(check(draft)).toEqual([
      expect.stringMatching(/example for g1-001 .* not quoted exactly/),
      'Use and quote target grammar point g1-002.',
    ]);
  });

  it('checks question shapes', () => {
    const draft = goodDraft();
    draft.choiceQuestions[0]!.options = ['书', '书', '茶', '米饭'];
    draft.choiceQuestions[1]!.answer = 4;
    draft.clozeQuestions.pop();
    expect(check(draft)).toEqual([
      'Multiple-choice question 1 needs 4 distinct options.',
      'Multiple-choice question 2 needs an answer index 0–3.',
      'Write exactly 3 cloze questions.',
    ]);
  });
});

describe('generatePassage', () => {
  const run = (llm: Llm, budgetUsd = 5) =>
    generatePassage({
      id: 'p1-0001',
      level: 1,
      targets,
      content,
      segmenter,
      llm,
      budgetUsd,
      now: () => new Date('2026-10-17T00:00:00Z'),
    });

  it('returns a verified passage with its questions and provenance', async () => {
    const { llm, calls } = fakeLlm([goodDraft()]);
    const result = await run(llm);

    expect(result.attempts).toBe(1);
    const passage = result.passage!;
    expect(passage).toMatchObject({
      _id: 'p1-0001',
      level: 1,
      title: '买东西',
      names: ['小明'],
      verification: { share: 1, offLevel: [] },
      generation: {
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        generatedAt: '2026-10-17T00:00:00.000Z',
        attempts: 1,
      },
    });
    expect(passage.questions.map((q) => `${q.id}:${q.type}`)).toEqual([
      'c1:choice',
      'c2:choice',
      'c3:choice',
      'z1:cloze',
      'z2:cloze',
      'z3:cloze',
    ]);
    // The system prompt carries the level's vocabulary and is cached.
    const system = calls[0]!.system as Anthropic.Messages.TextBlockParam[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    // Structured outputs: every object in the schema must be closed.
    const format = calls[0]!.output_config!.format!;
    expect(format.type).toBe('json_schema');
    const schemaObjects = objects(format.schema);
    expect(schemaObjects.length).toBe(4); // passage, grammar use, two question kinds
    for (const o of schemaObjects) expect(o.additionalProperties).toBe(false);
    expect(calls[0]!.messages[0]!.content).toMatch(/g1-001.*\n.*g1-002/);
  });

  it('sends problems back and accepts the revision', async () => {
    const bad = goodDraft();
    bad.clozeQuestions[0]!.sentence = '小明买了两本＿＿。';
    const { llm, calls } = fakeLlm([bad, goodDraft()]);
    const result = await run(llm);

    expect(result.attempts).toBe(2);
    expect(result.passage).not.toBeNull();
    const [, reply, feedback] = calls[1]!.messages;
    expect(reply).toMatchObject({ role: 'assistant' });
    expect(feedback).toMatchObject({ role: 'user' });
    expect(String(feedback!.content)).toMatch(
      /fix these problems[\s\S]*Cloze question 1/,
    );
    expect(result.costUsd).toBeCloseTo(2 * costOf(usage));
  });

  it('asks again when a reply is cut off', async () => {
    const { llm, calls } = fakeLlm(['{"title": "买东', goodDraft()]);
    const result = await run(llm);
    expect(result.attempts).toBe(2);
    expect(result.passage).not.toBeNull();
    // The cut-off reply isn't part of the conversation.
    expect(calls[1]!.messages).toHaveLength(1);
  });

  it('gives up after the last attempt, reporting the problems', async () => {
    const bad = { ...goodDraft(), choiceQuestions: [] };
    const { llm, calls } = fakeLlm([bad, bad, bad]);
    const result = await run(llm);
    expect(calls).toHaveLength(3);
    expect(result.passage).toBeNull();
    expect(result.problems).toContain(
      'Write exactly 3 multiple-choice questions.',
    );
  });

  it('stops before a call that could pass the budget', async () => {
    const { llm, calls } = fakeLlm([goodDraft()]);
    const result = await run(llm, 0.01);
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ passage: null, outOfBudget: true });
  });
});

describe('costOf', () => {
  it('prices input, output, and cache tokens', () => {
    // 1000 × $2 + 2000 × $10 + 3000 × $0.10 per million.
    expect(costOf(usage)).toBeCloseTo(0.0223);
    expect(
      costOf({
        ...usage,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(0.032);
  });
});

describe('systemPrompt', () => {
  it('lists only vocabulary at or below the level', () => {
    const text = systemPrompt(1, content)[0]!.text;
    expect(text).toContain('、学生、');
    expect(text).not.toContain('咖啡');
  });
});

describe('library', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hanyu-passages-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('writes, reads, and numbers passages per level', async () => {
    const { llm } = fakeLlm([goodDraft()]);
    const { passage } = await generatePassage({
      id: 'p1-0007',
      level: 1,
      targets,
      content,
      segmenter,
      llm,
      budgetUsd: 5,
    });
    writePassage(passage!, root);
    const stored = readPassages(1, root);
    expect(stored).toEqual([passage]);
    expect(nextPassageId(stored, 1)).toBe('p1-0008');
    expect(nextPassageId([], 2)).toBe('p2-0001');
    expect(readPassages(3, root)).toEqual([]);
  });

  it('orders grammar points least covered first', () => {
    const passages = [
      { grammar: [{ grammarId: 'g1-001' }, { grammarId: 'g1-001' }] },
      { grammar: [{ grammarId: 'g1-002' }, { grammarId: 'g1-001' }] },
    ] as unknown as Passage[];
    const coverage = grammarCoverage(content.grammar, passages, 1);
    expect(coverage).toHaveLength(70);
    expect(coverage[0]!.point._id).toBe('g1-003');
    expect(coverage.at(-2)).toMatchObject({
      point: { _id: 'g1-002' },
      passages: 1,
    });
    expect(coverage.at(-1)).toMatchObject({
      point: { _id: 'g1-001' },
      passages: 2,
    });
  });
});
