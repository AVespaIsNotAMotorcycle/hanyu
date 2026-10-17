// Generates one graded reading passage with Claude: a passage at an HSK
// level that exercises chosen grammar points, with multiple-choice and cloze
// questions. Drafts are checked (structure, level share, cloze answers) and
// sent back with the problems until they pass or attempts run out.

import type Anthropic from '@anthropic-ai/sdk';
import {
  CLOZE_BLANK,
  MIN_LEVEL_SHARE,
  type GrammarPoint,
  type HskLevel,
  type Passage,
  type PassageQuestion,
} from '@hanyu/shared';
import type { Segmenter } from '../segmenter.js';
import type { SeedContent } from './content.js';
import { checkLevel } from './level.js';

export const MODEL = 'claude-sonnet-5-5';
/** Bump when the prompt or schema changes; stored with each passage. */
export const PROMPT_VERSION = '1';

/**
 * USD per million tokens for claude-sonnet-5-5 (October 2026,
 * https://platform.claude.com/docs/en/about-claude/pricing).
 */
export const PRICING = {
  input: 2,
  output: 10,
  cacheWrite: 2.5,
  cacheRead: 0.1,
};

type Usage = Pick<
  Anthropic.Messages.Usage,
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_creation_input_tokens'
  | 'cache_read_input_tokens'
>;

export function costOf(usage: Usage): number {
  return (
    (usage.input_tokens * PRICING.input +
      usage.output_tokens * PRICING.output +
      (usage.cache_creation_input_tokens ?? 0) * PRICING.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * PRICING.cacheRead) /
    1_000_000
  );
}

/** The part of the Anthropic client the generator uses (fake in tests). */
export interface Llm {
  create(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ): Promise<
    Pick<Anthropic.Messages.Message, 'content' | 'usage' | 'stop_reason'>
  >;
}

/** Target length in characters, by level. */
export const LENGTHS: Record<HskLevel, [number, number]> = {
  1: [80, 150],
  2: [120, 220],
  3: [180, 320],
  4: [250, 450],
  5: [350, 600],
  6: [450, 750],
  7: [550, 900],
};
const CHOICE_QUESTIONS = 3;
const CLOZE_QUESTIONS = 3;
const MAX_NAMES = 3;

type JsonSchema = { [key: string]: unknown };

/** Structured outputs requires additionalProperties: false on every object. */
function closeObjects(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (out.type === 'object') out.additionalProperties = false;
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, JsonSchema>).map(
        ([key, value]) => [key, closeObjects(value)],
      ),
    );
  }
  if (out.items) out.items = closeObjects(out.items as JsonSchema);
  return out;
}

/**
 * The reply's JSON schema, enforced with structured outputs
 * (output_config.format). Sonnet 5.5 doesn't accept a forced tool_choice.
 */
const SCHEMA = closeObjects({
  type: 'object',
  required: [
    'title',
    'titleEnglish',
    'text',
    'names',
    'grammar',
    'choiceQuestions',
    'clozeQuestions',
  ],
  properties: {
    title: { type: 'string', description: 'Chinese title, at the level' },
    titleEnglish: { type: 'string' },
    text: {
      type: 'string',
      description:
        'The passage in simplified Chinese. Separate paragraphs with a blank line.',
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description: `Personal names used (at most ${MAX_NAMES}), e.g. 小明. They are the only words allowed outside the list.`,
    },
    grammar: {
      type: 'array',
      description:
        'Every target grammar point, with a span quoted exactly from the text that uses it.',
      items: {
        type: 'object',
        required: ['grammarId', 'example'],
        properties: {
          grammarId: { type: 'string' },
          example: { type: 'string' },
        },
      },
    },
    choiceQuestions: {
      type: 'array',
      description: `${CHOICE_QUESTIONS} comprehension questions about the passage.`,
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
            description: 'Exactly 4 distinct options in Chinese, at the level',
          },
          answer: {
            type: 'integer',
            description: 'Index (0–3) of the one correct option',
          },
          explanation: {
            type: 'string',
            description:
              'In English: why the answer is right, citing the passage',
          },
        },
      },
    },
    clozeQuestions: {
      type: 'array',
      description: `${CLOZE_QUESTIONS} fill-in-the-blank questions.`,
      items: {
        type: 'object',
        required: ['sentence', 'answer', 'alsoAccepted', 'hint'],
        properties: {
          sentence: {
            type: 'string',
            description: `A sentence copied exactly from the passage with one word replaced by ${CLOZE_BLANK}`,
          },
          answer: {
            type: 'string',
            description: 'The removed word, from the vocabulary list',
          },
          alsoAccepted: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Other list words that fit the blank equally well (often empty)',
          },
          hint: {
            type: 'string',
            description: 'A short English gloss of the missing word',
          },
        },
      },
    },
  },
});

interface Draft {
  title: string;
  titleEnglish: string;
  text: string;
  names: string[];
  grammar: { grammarId: string; example: string }[];
  choiceQuestions: {
    prompt: string;
    promptEnglish: string;
    options: string[];
    answer: number;
    explanation: string;
  }[];
  clozeQuestions: {
    sentence: string;
    answer: string;
    alsoAccepted: string[];
    hint: string;
  }[];
}

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
      text: `You write graded reading passages for adult learners of Mandarin Chinese at HSK 3.0 level ${level === 7 ? '7–9' : level}.

Rules:
- Write in simplified Chinese, ${min}–${max} characters, as a coherent short story, diary entry, dialogue, or message about everyday life. Make it natural and a little interesting, not a word list.
- Use only words from the vocabulary list below (all are at or below this level). The only exceptions are up to ${MAX_NAMES} personal names, which you must declare in "names". Numbers written with listed characters are fine.
- Prefer short sentences and common patterns. Do not use idioms or literary forms unless they are in the list.
- Use every target grammar point at least once, clearly, and quote the exact span that shows it.
- Questions must be answerable from the passage alone. Write question prompts and options at the same level, using the same vocabulary.
- Cloze questions: copy a sentence from the passage exactly, replace one meaningful word (not a name, not a particle) with ${CLOZE_BLANK}, and give that word as the answer. Choose words the passage's context makes recoverable.
- Reply with one JSON object in the required format.

Vocabulary list:
${vocabulary}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

export function userPrompt(level: HskLevel, targets: readonly GrammarPoint[]) {
  const lines = targets.map(
    (g) =>
      `- ${g._id}: ${[g.category, g.name, g.item].filter(Boolean).join(' / ')}${g.content ? ` — ${g.content}` : ''}`,
  );
  return `Write one HSK ${level === 7 ? '7–9' : level} passage that exercises these grammar points from the syllabus:
${lines.join('\n')}`;
}

const strip = (text: string) => text.replace(/\s+/g, '');
/** For matching quoted spans: ignores spacing and punctuation. */
const bare = (text: string) => text.replace(/[\s\p{P}]/gu, '');
const MAX_ANSWER_CHARS = 4;

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
  const flat = strip(text);

  const [min, max] = LENGTHS[level];
  const length = [...flat].length;
  if (length < min * 0.7 || length > max * 1.3) {
    problems.push(`The text is ${length} characters; aim for ${min}–${max}.`);
  }

  const atLevel = (text: string) =>
    checkLevel(text, level, {
      segmenter,
      wordLevels: content.wordLevels,
    }).offLevel.length === 0;
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

  const choice = draft.choiceQuestions ?? [];
  if (choice.length !== CHOICE_QUESTIONS) {
    problems.push(
      `Write exactly ${CHOICE_QUESTIONS} multiple-choice questions.`,
    );
  }
  choice.forEach((q, i) => {
    if (q.options?.length !== 4 || new Set(q.options).size !== 4) {
      problems.push(
        `Multiple-choice question ${i + 1} needs 4 distinct options.`,
      );
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) {
      problems.push(
        `Multiple-choice question ${i + 1} needs an answer index 0–3.`,
      );
    }
  });

  const cloze = draft.clozeQuestions ?? [];
  if (cloze.length !== CLOZE_QUESTIONS) {
    problems.push(`Write exactly ${CLOZE_QUESTIONS} cloze questions.`);
  }
  cloze.forEach((q, i) => {
    const n = i + 1;
    if (q.sentence?.split(CLOZE_BLANK).length !== 2) {
      problems.push(
        `Cloze question ${n} must contain exactly one ${CLOZE_BLANK}.`,
      );
      return;
    }
    if (!bare(text).includes(bare(q.sentence.replace(CLOZE_BLANK, q.answer)))) {
      problems.push(
        `Cloze question ${n}: with "${q.answer}" filled in, the sentence must match the text exactly.`,
      );
    }
    if ([...q.answer].length > MAX_ANSWER_CHARS || !atLevel(q.answer)) {
      problems.push(
        `Cloze question ${n}: the answer "${q.answer}" must be a word (at most ${MAX_ANSWER_CHARS} characters) from the vocabulary list.`,
      );
    } else if (![...q.answer].every((c) => content.writable.has(c))) {
      problems.push(
        `Cloze question ${n}: choose another answer ("${q.answer}" can't be handwritten).`,
      );
    }
  });

  const check = checkLevel(
    [text, ...choice.flatMap((q) => [q.prompt, ...(q.options ?? [])])].join(
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
  passage: Passage | null;
  costUsd: number;
  attempts: number;
  /** Problems with the last draft, if it never passed. */
  problems: string[];
  /** True if the run stopped because the next call could exceed the budget. */
  outOfBudget: boolean;
}

/**
 * Asks for a passage and revises it until it passes or `maxAttempts` runs
 * out. Stops before any call that could take spending past `budgetUsd`.
 */
export async function generatePassage({
  id,
  level,
  targets,
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
  content: SeedContent;
  segmenter: Segmenter;
  llm: Llm;
  /** What this passage may spend. */
  budgetUsd: number;
  maxAttempts?: number;
  now?: () => Date;
}): Promise<GenerateResult> {
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userPrompt(level, targets) },
  ];
  let costUsd = 0;
  let lastCost = 0;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A revision costs about what the last call did, plus the longer history.
    const estimate = lastCost ? lastCost * 1.5 : 0.05;
    if (costUsd + estimate > budgetUsd) {
      return {
        passage: null,
        costUsd,
        attempts: attempt - 1,
        problems,
        outOfBudget: true,
      };
    }
    const response = await llm.create({
      model: MODEL,
      max_tokens: 8000,
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
      // Cut off (max_tokens) or refused; ask again from scratch.
      problems = [
        `The reply was not complete JSON (stop reason: ${response.stop_reason ?? 'unknown'}).`,
      ];
      continue;
    }
    const result = draftProblems(draft, { level, targets, content, segmenter });
    problems = result.problems;
    if (problems.length === 0 && result.check) {
      return {
        passage: toPassage(draft, {
          id,
          level,
          check: result.check,
          generation: {
            model: MODEL,
            promptVersion: PROMPT_VERSION,
            generatedAt: now().toISOString(),
            attempts: attempt,
            costUsd: Math.round(costUsd * 10000) / 10000,
          },
        }),
        costUsd,
        attempts: attempt,
        problems: [],
        outOfBudget: false,
      };
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
    passage: null,
    costUsd,
    attempts: maxAttempts,
    problems,
    outOfBudget: false,
  };
}

function toPassage(
  draft: Draft,
  {
    id,
    level,
    check,
    generation,
  }: {
    id: string;
    level: HskLevel;
    check: Passage['verification'];
    generation: Passage['generation'];
  },
): Passage {
  const questions: PassageQuestion[] = [
    ...draft.choiceQuestions.map((q, i): PassageQuestion => ({
      id: `c${i + 1}`,
      type: 'choice',
      prompt: q.prompt,
      promptEnglish: q.promptEnglish,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
    })),
    ...draft.clozeQuestions.map((q, i): PassageQuestion => ({
      id: `z${i + 1}`,
      type: 'cloze',
      sentence: q.sentence,
      answer: q.answer,
      alsoAccepted: q.alsoAccepted ?? [],
      hint: q.hint,
    })),
  ];
  return {
    _id: id,
    level,
    title: draft.title,
    titleEnglish: draft.titleEnglish,
    text: draft.text.trim(),
    names: draft.names ?? [],
    grammar: draft.grammar,
    questions,
    verification: check,
    generation,
  };
}
