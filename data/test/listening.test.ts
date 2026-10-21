import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { CHECK_PROMPT_VERSION } from '../src/passages/answerKey.js';
import { loadSeedContent } from '../src/passages/content.js';
import { nextPassageId } from '../src/passages/library.js';
import { MODEL, type Llm } from '../src/passages/llm.js';
import {
  draftProblems,
  generateExercise,
  PROMPT_VERSION,
  userPrompt,
} from '../src/listening/generate.js';
import {
  deleteExercise,
  readExercises,
  writeExercise,
} from '../src/listening/library.js';
import { formatForReview } from '../src/listening/review.js';
import { createSegmenter } from '../src/segmenter.js';

const content = loadSeedContent();
const segmenter = createSegmenter(content.wordLevels.keys());
const targets = content.grammar.filter((g) => g._id === 'g1-002');

/** A draft that passes every check at HSK 1. */
const goodDraft = () => ({
  topic: 'Plans to go shopping',
  text: '明天是星期六，我和朋友们去商店买东西。我们下午三点去。',
  textEnglish:
    "Tomorrow is Saturday; my friends and I are going to the shop. We're going at three in the afternoon.",
  names: [] as string[],
  grammar: [{ grammarId: 'g1-002', example: '朋友们' }],
  questions: [
    {
      prompt: '他们明天去哪儿？',
      promptEnglish: 'Where are they going tomorrow?',
      options: ['商店', '学校', '医院', '饭店'],
      answer: 0,
      explanation: 'They are going to the shop.',
    },
    {
      prompt: '他们几点去？',
      promptEnglish: 'What time are they going?',
      options: ['上午十点', '下午三点', '下午五点', '中午十二点'],
      answer: 1,
      explanation: 'They go at three in the afternoon.',
    },
  ],
});

const check = (draft: ReturnType<typeof goodDraft>) =>
  draftProblems(draft, { level: 1, targets, content, segmenter }).problems;

const usage = {
  input_tokens: 500,
  output_tokens: 500,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3000,
};

type Params = Anthropic.Messages.MessageCreateParamsNonStreaming;
const isCheckCall = (params: Params) =>
  typeof params.system === 'string' && params.system.includes('You check');

const agreeingCheck = () => ({
  choiceAnswers: [
    { questionId: 'c1', answer: 0, alsoDefensible: [] },
    { questionId: 'c2', answer: 1, alsoDefensible: [] },
  ],
  clozeAnswers: [],
  issues: [],
});

function fakeLlm(drafts: unknown[], checks: unknown[] = []) {
  const calls: Params[] = [];
  const checkCalls: Params[] = [];
  const llm: Llm = {
    async create(params) {
      let reply: unknown;
      if (isCheckCall(params)) {
        checkCalls.push(structuredClone(params));
        reply = checks[checkCalls.length - 1] ?? agreeingCheck();
      } else {
        calls.push(structuredClone(params));
        reply = drafts[calls.length - 1];
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(reply),
            citations: null,
          } as Anthropic.Messages.TextBlock,
        ],
        usage: usage as Anthropic.Messages.Usage,
        stop_reason: 'end_turn',
      };
    },
  };
  return { llm, calls, checkCalls };
}

const run = (llm: Llm) =>
  generateExercise({
    id: 'l1-0001',
    level: 1,
    targets,
    usedTopics: ['Ordering tea'],
    content,
    segmenter,
    llm,
    budgetUsd: 1,
    now: () => new Date('2026-10-20T00:00:00Z'),
  });

describe('listening draftProblems', () => {
  it('passes a good draft', () => {
    expect(check(goodDraft())).toEqual([]);
  });

  it('limits the text to three sentences in one paragraph', () => {
    const draft = goodDraft();
    draft.text += '我想买书。你去不去？';
    expect(check(draft)).toEqual(['The text has 4 sentences; write 1–3.']);
    draft.text = '明天是星期六。\n\n我们下午三点去商店。';
    expect(check(draft)).toEqual([
      'Write the text as one paragraph.',
      'The example for g1-002 ("朋友们") is not quoted exactly from the text.',
    ]);
  });

  it('checks question count and shape', () => {
    const draft = goodDraft();
    draft.questions[0]!.options = ['商店', '商店', '医院', '饭店'];
    draft.questions.push(draft.questions[1]!, draft.questions[1]!);
    expect(check(draft)).toEqual([
      'Write 1–2 questions.',
      'Question 1 needs 4 distinct options.',
    ]);
  });

  it('names off-level words for the model to replace', () => {
    const draft = goodDraft();
    draft.text = '明天我和朋友们去博物馆参观，欣赏美丽的风景。';
    draft.grammar = [{ grammarId: 'g1-002', example: '朋友们' }];
    expect(check(draft).join('\n')).toMatch(/Replace these: .*博物馆/);
  });
});

describe('generateExercise', () => {
  it('returns a checked exercise with its provenance', async () => {
    const { llm, calls, checkCalls } = fakeLlm([goodDraft()]);
    const { exercise, attempts } = await run(llm);
    expect(attempts).toBe(1);
    expect(exercise).toMatchObject({
      _id: 'l1-0001',
      level: 1,
      topic: 'Plans to go shopping',
      verification: { share: 1 },
      answerKeyCheck: { passed: true, promptVersion: CHECK_PROMPT_VERSION },
      generation: {
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        generatedAt: '2026-10-20T00:00:00.000Z',
        attempts: 1,
      },
    });
    expect(exercise!.questions.map((q) => `${q.id}:${q.type}`)).toEqual([
      'c1:choice',
      'c2:choice',
    ]);
    // Steered away from topics already used.
    expect(calls[0]!.messages[0]!.content).toMatch(/- Ordering tea/);
    // The checker reads the transcript without the key.
    const sent = String(checkCalls[0]!.messages[0]!.content);
    expect(sent).toMatch(/^Passage:\n\n明天是星期六/);
    expect(sent).not.toContain('They are going to the shop');
  });

  it('sends the answer-key check’s problems back for revision', async () => {
    const disagreeing = {
      ...agreeingCheck(),
      choiceAnswers: [
        { questionId: 'c1', answer: 0, alsoDefensible: [] },
        { questionId: 'c2', answer: 2, alsoDefensible: [] },
      ],
    };
    const { llm, calls } = fakeLlm([goodDraft(), goodDraft()], [disagreeing]);
    const { exercise, attempts } = await run(llm);
    expect(attempts).toBe(2);
    expect(exercise?.answerKeyCheck?.passed).toBe(true);
    expect(calls[1]!.messages.at(-1)!.content).toMatch(
      /- Question 2: an independent reader chose "下午五点"/,
    );
  });

  it('gives up after the last attempt', async () => {
    const bad = { ...goodDraft(), questions: [] };
    const { llm } = fakeLlm([bad, bad, bad]);
    const result = await run(llm);
    expect(result.exercise).toBeNull();
    expect(result.attempts).toBe(3);
    expect(result.problems).toContain('Write 1–2 questions.');
  });
});

describe('listening library', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hanyu-listening-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('writes, reads, numbers, formats, and deletes exercises', async () => {
    const { exercise } = await run(fakeLlm([goodDraft()]).llm);
    writeExercise(exercise!, root);
    const read = readExercises(1, root);
    expect(read).toEqual([exercise]);
    expect(nextPassageId(read, 1, 'l')).toBe('l1-0002');
    const text = formatForReview(exercise!, { clips: {} });
    expect(text).toContain('明天是星期六');
    expect(text).toContain('Recording: none yet');
    expect(text).toContain('→ B. 下午三点');
    deleteExercise(exercise!, root);
    expect(readExercises(1, root)).toEqual([]);
  });

  it('tells the generator what to write', () => {
    expect(userPrompt(1, targets)).toMatch(/g1-002/);
    expect(userPrompt(1, targets)).not.toMatch(/already cover/);
  });
});
