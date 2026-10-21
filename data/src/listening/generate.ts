// Generates one listening exercise with Claude: one to three sentences at an
// HSK level, to be read aloud with the text hidden, and multiple-choice
// questions about them. Drafts are checked (shape, sentence count, level
// share), then answered from the transcript by an independent call (the
// passages' answer-key check), and sent back with the problems until they
// pass or attempts run out.

import type Anthropic from '@anthropic-ai/sdk';
import {
  countSentences,
  LISTENING_QUESTIONS,
  MAX_LISTENING_SENTENCES,
  MIN_LEVEL_SHARE,
  type ChoiceQuestion,
  type GrammarPoint,
  type HskLevel,
  type ListeningExercise,
} from '@hanyu/shared';
import type { Segmenter } from '../segmenter.js';
import { checkAnswerKey } from '../passages/answerKey.js';
import type { SeedContent } from '../passages/content.js';
import { checkLevel } from '../passages/level.js';
import { closeObjects, costOf, MODEL, type Llm } from '../passages/llm.js';

/** Bump when the prompt or schema changes; stored with each exercise. */
export const PROMPT_VERSION = '1';

/** Target length of the text in characters, by level. */
export const LENGTHS: Record<HskLevel, [number, number]> = {
  1: [12, 40],
  2: [20, 55],
  3: [30, 75],
  4: [40, 95],
  5: [50, 115],
  6: [60, 130],
  7: [70, 150],
};
const MAX_NAMES = 2;
const [MIN_QUESTIONS, MAX_QUESTIONS] = LISTENING_QUESTIONS;

const SCHEMA = closeObjects({
  type: 'object',
  required: ['topic', 'text', 'textEnglish', 'names', 'grammar', 'questions'],
  properties: {
    topic: {
      type: 'string',
      description:
        'A few English words for the situation, e.g. "Asking the way to the station"',
    },
    text: {
      type: 'string',
      description: `What is read aloud: 1–${MAX_LISTENING_SENTENCES} sentences in simplified Chinese, one speaker.`,
    },
    textEnglish: {
      type: 'string',
      description: 'A faithful English translation',
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description: `Personal names used (at most ${MAX_NAMES}). They are the only words allowed outside the list.`,
    },
    grammar: {
      type: 'array',
      description:
        'The target grammar point, with a span quoted exactly from the text that uses it.',
      items: {
        type: 'object',
        required: ['grammarId', 'example'],
        properties: {
          grammarId: { type: 'string' },
          example: { type: 'string' },
        },
      },
    },
    questions: {
      type: 'array',
      description: `${MIN_QUESTIONS}–${MAX_QUESTIONS} listening-comprehension questions.`,
      items: {
        type: 'object',
        required: [
          'prompt',
          'promptEnglish',
          'options',
          'answer',
          'explanation',
        ],
        properties: {
          prompt: { type: 'string', description: 'In Chinese, at the level' },
          promptEnglish: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Exactly 4 distinct short options in Chinese, at the level',
          },
          answer: {
            type: 'integer',
            description: 'Index (0–3) of the one correct option',
          },
          explanation: {
            type: 'string',
            description:
              'In English: why the answer is right, citing what was said',
          },
        },
      },
    },
  },
});

interface Draft {
  topic: string;
  text: string;
  textEnglish: string;
  names: string[];
  grammar: { grammarId: string; example: string }[];
  questions: Omit<ChoiceQuestion, 'id' | 'type'>[];
}

const label = (level: HskLevel) => (level === 7 ? '7–9' : String(level));

/** The level's cacheable system prompt: rules plus the vocabulary list. */
export function systemPrompt(
  level: HskLevel,
  content: SeedContent,
): Anthropic.Messages.TextBlockParam[] {
  const [min, max] = LENGTHS[level];
  const vocabulary = [
    ...new Set(
      content.words.filter((w) => w.level <= level).map((w) => w.simplified),
    ),
  ].join('、');
  return [
    {
      type: 'text',
      text: `You write listening exercises for adult learners of Mandarin Chinese at HSK 3.0 level ${label(level)}. A recorded voice reads the text aloud; learners never see it. They then answer multiple-choice questions, which they read on screen.

Rules:
- Write 1–${MAX_LISTENING_SENTENCES} sentences of natural spoken simplified Chinese, ${min}–${max} characters, as one speaker: an announcement, a voicemail, someone describing their plans, a request, a short anecdote. No dialogue (there is only one voice), no lists, nothing that only makes sense written down.
- Use only words from the vocabulary list below (all are at or below this level). The only exceptions are up to ${MAX_NAMES} personal names, which you must declare in "names". Numbers, times, and prices written with listed characters are fine and make good questions.
- Avoid words that are easy to mishear for another word in context (near-homophones), unless the context settles them.
- Use the target grammar point clearly, and quote the exact span that shows it.
- Write ${MIN_QUESTIONS}–${MAX_QUESTIONS} questions (${MAX_QUESTIONS} when there is enough to ask about). Each must need the recording: not answerable from common sense or from the options alone. Every option must be plausible in the situation, and exactly one must match what was said. Write prompts and options at the same level, with the same vocabulary, and keep options short.
- Reply with one JSON object in the required format.

Vocabulary list:
${vocabulary}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

export function userPrompt(
  level: HskLevel,
  targets: readonly GrammarPoint[],
  usedTopics: readonly string[] = [],
) {
  const lines = targets.map(
    (g) =>
      `- ${g._id}: ${[g.category, g.name, g.item].filter(Boolean).join(' / ')}${g.content ? ` — ${g.content}` : ''}`,
  );
  const avoid = usedTopics.length
    ? `\n\nOther exercises already cover these situations; choose a different one:\n${usedTopics.map((t) => `- ${t}`).join('\n')}`
    : '';
  return `Write one HSK ${label(level)} listening exercise that uses this grammar point from the syllabus:
${lines.join('\n')}${avoid}`;
}

const strip = (text: string) => text.replace(/\s+/g, '');
/** For matching quoted spans: ignores spacing and punctuation. */
const bare = (text: string) => text.replace(/[\s\p{P}]/gu, '');

/** Problems with a draft, phrased for the model to fix. Empty means it passes. */
export function draftProblems(
  draft: Draft,
  {
    level,
    targets,
    content,
    segmenter,
  }: {
    level: HskLevel;
    targets: readonly GrammarPoint[];
    content: SeedContent;
    segmenter: Segmenter;
  },
): { problems: string[]; check: ReturnType<typeof checkLevel> | null } {
  const problems: string[] = [];
  const text = draft.text?.trim() ?? '';
  if (!text) return { problems: ['The text is empty.'], check: null };

  const [min, max] = LENGTHS[level];
  const length = [...strip(text)].length;
  if (length < min * 0.7 || length > max * 1.3) {
    problems.push(`The text is ${length} characters; aim for ${min}–${max}.`);
  }
  const sentences = countSentences(text);
  if (sentences < 1 || sentences > MAX_LISTENING_SENTENCES) {
    problems.push(
      `The text has ${sentences} sentences; write 1–${MAX_LISTENING_SENTENCES}.`,
    );
  }
  if (/\n/.test(text)) problems.push('Write the text as one paragraph.');

  const names = draft.names ?? [];
  if (names.length > MAX_NAMES) {
    problems.push(
      `Use at most ${MAX_NAMES} names (you declared ${names.length}).`,
    );
  }
  for (const name of names) {
    if (
      ![...name].every((c) => /\p{Script=Han}/u.test(c)) ||
      [...name].length > 4
    ) {
      problems.push(`"${name}" doesn't look like a personal name.`);
    }
  }

  const levelIds = new Set(
    content.grammar.filter((g) => g.level === level).map((g) => g._id),
  );
  for (const use of draft.grammar ?? []) {
    if (!levelIds.has(use.grammarId)) {
      problems.push(
        `Grammar point ${use.grammarId} is not a level-${level} point.`,
      );
    } else if (!bare(text).includes(bare(use.example))) {
      problems.push(
        `The example for ${use.grammarId} ("${use.example}") is not quoted exactly from the text.`,
      );
    }
  }
  for (const target of targets) {
    if (!(draft.grammar ?? []).some((g) => g.grammarId === target._id)) {
      problems.push(`Use and quote target grammar point ${target._id}.`);
    }
  }

  const questions = draft.questions ?? [];
  if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
    problems.push(`Write ${MIN_QUESTIONS}–${MAX_QUESTIONS} questions.`);
  }
  questions.forEach((q, i) => {
    if (q.options?.length !== 4 || new Set(q.options).size !== 4) {
      problems.push(`Question ${i + 1} needs 4 distinct options.`);
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) {
      problems.push(`Question ${i + 1} needs an answer index 0–3.`);
    }
  });

  const check = checkLevel(
    [text, ...questions.flatMap((q) => [q.prompt, ...(q.options ?? [])])].join(
      '\n',
    ),
    level,
    { segmenter, wordLevels: content.wordLevels, names },
  );
  if (check.share < MIN_LEVEL_SHARE) {
    problems.push(
      `Only ${(check.share * 100).toFixed(1)}% of words are at or below the level (need ${MIN_LEVEL_SHARE * 100}%). Replace these: ${check.offLevel.join('、')}.`,
    );
  }
  return { problems, check };
}

export interface GenerateResult {
  exercise: ListeningExercise | null;
  costUsd: number;
  attempts: number;
  /** Problems with the last draft, if it never passed. */
  problems: string[];
  /** True if the run stopped because the next call could exceed the budget. */
  outOfBudget: boolean;
}

/**
 * Asks for an exercise and revises it until it passes or `maxAttempts` runs
 * out. Stops before any call that could take spending past `budgetUsd`.
 */
export async function generateExercise({
  id,
  level,
  targets,
  usedTopics = [],
  content,
  segmenter,
  llm,
  budgetUsd,
  maxAttempts = 3,
  now = () => new Date(),
}: {
  id: string;
  level: HskLevel;
  targets: readonly GrammarPoint[];
  /** Topics of the level's other exercises, to steer away from. */
  usedTopics?: readonly string[];
  content: SeedContent;
  segmenter: Segmenter;
  llm: Llm;
  /** What this exercise may spend. */
  budgetUsd: number;
  maxAttempts?: number;
  now?: () => Date;
}): Promise<GenerateResult> {
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userPrompt(level, targets, usedTopics) },
  ];
  let costUsd = 0;
  let lastCost = 0;
  let checkCost = 0;
  let problems: string[] = [];
  const outOfBudget = (attempts: number): GenerateResult => ({
    exercise: null,
    costUsd,
    attempts,
    problems,
    outOfBudget: true,
  });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A revision costs about what the last call did, plus the longer history.
    const estimate = lastCost ? lastCost * 1.5 : 0.03;
    if (costUsd + estimate > budgetUsd) return outOfBudget(attempt - 1);
    const response = await llm.create({
      model: MODEL,
      max_tokens: 3000,
      system: systemPrompt(level, content),
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages,
    });
    lastCost = costOf(response.usage);
    costUsd += lastCost;

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let draft: Draft;
    try {
      draft = JSON.parse(reply) as Draft;
    } catch {
      problems = [
        `The reply was not complete JSON (stop reason: ${response.stop_reason ?? 'unknown'}).`,
      ];
      continue;
    }
    const result = draftProblems(draft, { level, targets, content, segmenter });
    problems = result.problems;
    if (problems.length === 0 && result.check) {
      const exercise = toExercise(draft, {
        id,
        level,
        check: result.check,
        generation: {
          model: MODEL,
          promptVersion: PROMPT_VERSION,
          generatedAt: now().toISOString(),
          attempts: attempt,
          costUsd: 0,
        },
      });
      if (costUsd + (checkCost || 0.01) > budgetUsd) {
        return outOfBudget(attempt);
      }
      const keyCheck = await checkAnswerKey(asPassage(exercise), { llm, now });
      checkCost = keyCheck.costUsd;
      costUsd += checkCost;
      problems = keyCheck.problems.map(renameQuestions);
      if (problems.length === 0) {
        exercise.answerKeyCheck = keyCheck.check;
        exercise.generation.costUsd = Math.round(costUsd * 10000) / 10000;
        return {
          exercise,
          costUsd,
          attempts: attempt,
          problems: [],
          outOfBudget: false,
        };
      }
    }
    messages.push(
      {
        role: 'assistant',
        content: response.content as Anthropic.Messages.ContentBlockParam[],
      },
      {
        role: 'user',
        content: `Please fix these problems and reply with the whole revised JSON:\n${problems.map((p) => `- ${p}`).join('\n')}`,
      },
    );
  }
  return {
    exercise: null,
    costUsd,
    attempts: maxAttempts,
    problems,
    outOfBudget: false,
  };
}

/** The exercise as the answer-key check sees it: an untitled passage. */
export const asPassage = (exercise: ListeningExercise) => ({
  title: '',
  text: exercise.text,
  questions: exercise.questions,
});

/** The check names questions as the passages do; here they're all choice. */
const renameQuestions = (problem: string) =>
  problem.replace(/^Multiple-choice question/, 'Question');

function toExercise(
  draft: Draft,
  {
    id,
    level,
    check,
    generation,
  }: {
    id: string;
    level: HskLevel;
    check: ListeningExercise['verification'];
    generation: ListeningExercise['generation'];
  },
): ListeningExercise {
  return {
    _id: id,
    level,
    text: draft.text.trim(),
    textEnglish: draft.textEnglish,
    topic: draft.topic,
    names: draft.names ?? [],
    grammar: draft.grammar,
    questions: draft.questions.map((q, i) => ({
      id: `c${i + 1}`,
      type: 'choice',
      prompt: q.prompt,
      promptEnglish: q.promptEnglish,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
    })),
    verification: check,
    answerKeyCheck: null,
    review: null,
    generation,
  };
}
