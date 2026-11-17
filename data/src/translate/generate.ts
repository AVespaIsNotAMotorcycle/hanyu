// Generates one English → Chinese translation exercise with Claude: a short
// English paragraph that a learner at an HSK level can translate with the
// level's vocabulary, and a reference Chinese translation that proves it.
// Drafts are checked (shape, sentence count, the reference's level share),
// then the reference is checked by an independent call (check.ts), and the
// draft is sent back with the problems until it passes or attempts run out.

import type Anthropic from '@anthropic-ai/sdk';
import {
  countSentences,
  MIN_LEVEL_SHARE,
  type GrammarPoint,
  type HskLevel,
  type TranslateExercise,
} from '@hanyu/shared';
import type { Segmenter } from '../segmenter.js';
import type { SeedContent } from '../passages/content.js';
import { checkLevel, tokenize } from '../passages/level.js';
import { closeObjects, costOf, MODEL, type Llm } from '../passages/llm.js';
import { checkReference } from './check.js';

/** Bump when the prompt or schema changes; stored with each exercise. */
export const PROMPT_VERSION = '1';

/** Target length of the reference in characters, by level. */
export const LENGTHS: Record<HskLevel, [number, number]> = {
  1: [15, 40],
  2: [25, 60],
  3: [35, 80],
  4: [45, 100],
  5: [55, 120],
  6: [65, 135],
  7: [75, 150],
};
/** Sentences in an exercise, fewest to most. */
export const SENTENCES: [number, number] = [2, 4];

const SCHEMA = closeObjects({
  type: 'object',
  required: ['topic', 'english', 'reference', 'grammar'],
  properties: {
    topic: {
      type: 'string',
      description:
        'A few English words for the situation, e.g. "Inviting a friend to dinner"',
    },
    english: {
      type: 'string',
      description: `What the learner translates: ${SENTENCES[0]}–${SENTENCES[1]} sentences of natural English, one paragraph.`,
    },
    reference: {
      type: 'string',
      description:
        'A faithful, natural translation into simplified Chinese, using only the vocabulary list.',
    },
    grammar: {
      type: 'array',
      description:
        'The target grammar point, with a span quoted exactly from the reference that uses it.',
      items: {
        type: 'object',
        required: ['grammarId', 'example'],
        properties: {
          grammarId: { type: 'string' },
          example: { type: 'string' },
        },
      },
    },
  },
});

interface Draft {
  topic: string;
  english: string;
  reference: string;
  grammar: { grammarId: string; example: string }[];
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
      text: `You write English → Chinese translation exercises for adult learners of Mandarin Chinese at HSK 3.0 level ${label(level)}. Learners read a short English paragraph and write it in Chinese. An automatic grader then compares their Chinese with your reference translation.

Rules:
- Write ${SENTENCES[0]}–${SENTENCES[1]} sentences of natural, everyday English as one paragraph: plans, a short anecdote, a message to a friend, a description of someone's routine. Keep it concrete.
- The English must be translatable with the vocabulary list below (all words are at or below this level). Avoid idioms, phrasal verbs, and ideas that would need words outside the list, and anything whose Chinese depends on knowledge the English doesn't give.
- Don't use personal names: say "my older brother", "my teacher", "a classmate", and so on. Place names only if they are on the list (中国, 北京).
- Write the reference: a faithful, natural Chinese translation, ${min}–${max} characters, the way a native speaker would say it using only words on the list. Numbers and times written with listed characters are fine.
- Use the target grammar point in the reference, and write the English so that a learner would naturally need it. Quote the exact span of the reference that shows it.
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
  return `Write one HSK ${label(level)} English → Chinese translation exercise whose reference uses this grammar point from the syllabus:
${lines.join('\n')}${avoid}`;
}

const strip = (text: string) => text.replace(/\s+/g, '');
/** For matching quoted spans: ignores spacing and punctuation. */
const bare = (text: string) => text.replace(/[\s\p{P}]/gu, '');
/** English sentences: runs ending in . ! ? (or the end of the text). */
const englishSentences = (text: string) =>
  (text.match(/[^.!?]+[.!?]*/g) ?? []).filter((s) => /[A-Za-z]/.test(s)).length;

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
  const english = draft.english?.trim() ?? '';
  const reference = draft.reference?.trim() ?? '';
  if (!english) problems.push('The English is empty.');
  if (!reference) problems.push('The reference is empty.');
  if (problems.length) return { problems, check: null };

  if (/\p{Script=Han}/u.test(english)) {
    problems.push('Write the English without Chinese characters.');
  }
  if (/\n/.test(english) || /\n/.test(reference)) {
    problems.push('Write the English and the reference as one paragraph each.');
  }
  const [minSentences, maxSentences] = SENTENCES;
  const sentences = englishSentences(english);
  if (sentences < minSentences || sentences > maxSentences) {
    problems.push(
      `The English has ${sentences} sentences; write ${minSentences}–${maxSentences}.`,
    );
  }
  const chineseSentences = countSentences(reference);
  if (chineseSentences < 1 || chineseSentences > maxSentences + 1) {
    problems.push(
      `The reference has ${chineseSentences} sentences; match the English.`,
    );
  }
  const [min, max] = LENGTHS[level];
  const length = [...strip(reference)].length;
  if (length < min * 0.7 || length > max * 1.3) {
    problems.push(
      `The reference is ${length} characters; aim for ${min}–${max}.`,
    );
  }

  const levelIds = new Set(
    content.grammar.filter((g) => g.level === level).map((g) => g._id),
  );
  for (const use of draft.grammar ?? []) {
    if (!levelIds.has(use.grammarId)) {
      problems.push(
        `Grammar point ${use.grammarId} is not a level-${level} point.`,
      );
    } else if (!bare(reference).includes(bare(use.example))) {
      problems.push(
        `The example for ${use.grammarId} ("${use.example}") is not quoted exactly from the reference.`,
      );
    }
  }
  for (const target of targets) {
    if (!(draft.grammar ?? []).some((g) => g.grammarId === target._id)) {
      problems.push(`Use and quote target grammar point ${target._id}.`);
    }
  }

  // No names: everything in the reference must be level vocabulary.
  const check = checkLevel(reference, level, {
    segmenter,
    wordLevels: content.wordLevels,
  });
  if (check.share < MIN_LEVEL_SHARE) {
    problems.push(
      `Only ${(check.share * 100).toFixed(1)}% of the reference's words are at or below the level (need ${MIN_LEVEL_SHARE * 100}%). Replace these, rewording the English if needed: ${check.offLevel.join('、')}.`,
    );
  }
  return { problems, check };
}

export interface GenerateResult {
  exercise: TranslateExercise | null;
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
      max_tokens: 2000,
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
        tokens: tokenize(draft.reference.trim(), {
          segmenter,
          wordLevels: content.wordLevels,
        }).flat(),
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
      const referenceCheck = await checkReference(exercise, { llm, now });
      checkCost = referenceCheck.costUsd;
      costUsd += checkCost;
      problems = referenceCheck.problems;
      if (problems.length === 0) {
        exercise.answerKeyCheck = referenceCheck.check;
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

function toExercise(
  draft: Draft,
  {
    id,
    level,
    check,
    tokens,
    generation,
  }: {
    id: string;
    level: HskLevel;
    check: TranslateExercise['verification'];
    tokens: string[];
    generation: TranslateExercise['generation'];
  },
): TranslateExercise {
  return {
    _id: id,
    level,
    english: draft.english.trim(),
    reference: draft.reference.trim(),
    topic: draft.topic,
    tokens,
    grammar: draft.grammar,
    verification: check,
    answerKeyCheck: null,
    review: null,
    generation,
  };
}
