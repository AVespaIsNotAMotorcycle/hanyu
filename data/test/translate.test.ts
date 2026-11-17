import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSeedContent } from '../src/passages/content.js';
import { nextPassageId } from '../src/passages/library.js';
import type { Llm } from '../src/passages/llm.js';
import { createSegmenter } from '../src/segmenter.js';
import { CHECK_PROMPT_VERSION, needsCheck } from '../src/translate/check.js';
import {
  draftProblems,
  generateExercise,
  PROMPT_VERSION,
  userPrompt,
} from '../src/translate/generate.js';
import {
  deleteExercise,
  readExercises,
  writeExercise,
} from '../src/translate/library.js';
import { formatForReview } from '../src/translate/review.js';

const content = loadSeedContent();
const segmenter = createSegmenter(content.wordLevels.keys());
const targets = content.grammar.filter((g) => g._id === 'g1-002');

/** A draft that passes every check at HSK 1. */
const goodDraft = () => ({
  topic: 'Plans to go shopping',
  english:
    'Tomorrow is Saturday. My friends and I are going to the shop to buy things. We are going at three in the afternoon.',
  reference: '明天是星期六。我和朋友们去商店买东西。我们下午三点去。',
  grammar: [{ grammarId: 'g1-002', example: '朋友们' }],
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

function fakeLlm(drafts: unknown[], checks: unknown[] = []) {
  const calls: Params[] = [];
  const checkCalls: Params[] = [];
  const llm: Llm = {
    async create(params) {
      let reply: unknown;
      if (isCheckCall(params)) {
        checkCalls.push(structuredClone(params));
        reply = checks[checkCalls.length - 1] ?? { issues: [] };
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

describe('translate drafts', () => {
  it('accepts a good draft', () => {
    expect(check(goodDraft())).toEqual([]);
  });

  it('checks sentences, length, grammar quotes, and the level', () => {
    const problems = check({
      ...goodDraft(),
      english: 'Tomorrow is Saturday.',
      reference: '明天是星期六，我和朋友们去图书馆借小说。',
      grammar: [{ grammarId: 'g1-002', example: '同学们' }],
    });
    expect(problems.join('\n')).toMatch(/1 sentences; write 2–4/);
    expect(problems.join('\n')).toMatch(/not quoted exactly/);
    expect(problems.join('\n')).toMatch(/at or below the level/);
  });

  it('wants English without hanzi and the target grammar point', () => {
    const problems = check({
      ...goodDraft(),
      english: 'Tomorrow is 星期六. We go shopping.',
      grammar: [],
    });
    expect(problems).toContain('Write the English without Chinese characters.');
    expect(problems).toContain('Use and quote target grammar point g1-002.');
  });

  it('steers away from used topics', () => {
    expect(userPrompt(1, targets, ['Ordering food'])).toMatch(
      /- Ordering food/,
    );
  });
});

describe('generateExercise', () => {
  const run = (llm: Llm) =>
    generateExercise({
      id: 't1-0001',
      level: 1,
      targets,
      content,
      segmenter,
      llm,
      budgetUsd: 1,
      now: () => new Date('2026-11-16T00:00:00Z'),
    });

  it('returns a checked exercise with tokens', async () => {
    const { llm, checkCalls } = fakeLlm(
      [goodDraft()],
      [{ issues: [{ severity: 'minor', description: 'Fine.' }] }],
    );
    const result = await run(llm);
    expect(result.problems).toEqual([]);
    const exercise = result.exercise!;
    expect(exercise).toMatchObject({
      _id: 't1-0001',
      level: 1,
      reference: goodDraft().reference,
      generation: { promptVersion: PROMPT_VERSION, attempts: 1 },
      answerKeyCheck: {
        passed: true,
        answers: [],
        promptVersion: CHECK_PROMPT_VERSION,
      },
    });
    expect(exercise.tokens.join('')).toBe(goodDraft().reference);
    expect(exercise.tokens).toContain('商店');
    expect(checkCalls[0]!.messages[0]!.content).toContain(
      goodDraft().reference,
    );
    expect(needsCheck(exercise)).toBe(false);
  });

  it('sends a failed reference check back to be fixed', async () => {
    const { llm, calls } = fakeLlm(
      [goodDraft(), goodDraft()],
      [{ issues: [{ severity: 'major', description: 'Drops a clause.' }] }],
    );
    const result = await run(llm);
    expect(result.exercise?.generation.attempts).toBe(2);
    const revision = calls[1]!.messages.at(-1)!.content as string;
    expect(revision).toMatch(/Drops a clause/);
  });

  it('gives up after three failed drafts', async () => {
    const bad = { ...goodDraft(), reference: '' };
    const { llm } = fakeLlm([bad, bad, bad]);
    const result = await run(llm);
    expect(result.exercise).toBeNull();
    expect(result.problems).toContain('The reference is empty.');
  });
});

describe('translate library', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'translate-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('writes, reads, numbers, formats, and deletes exercises', async () => {
    const { llm } = fakeLlm([goodDraft()]);
    const { exercise } = await generateExercise({
      id: 't1-0001',
      level: 1,
      targets,
      content,
      segmenter,
      llm,
      budgetUsd: 1,
    });
    writeExercise(exercise!, root);
    const read = readExercises(1, root);
    expect(read).toEqual([exercise]);
    expect(nextPassageId(read, 1, 't')).toBe('t1-0002');
    expect(formatForReview(exercise!)).toMatch(/Reference check .*: passed/);
    deleteExercise(exercise!, root);
    expect(readExercises(1, root)).toEqual([]);
  });
});
