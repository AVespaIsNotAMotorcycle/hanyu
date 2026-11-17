// The reference check for English → Chinese exercises: a separate call reads
// the English and the reference Chinese and reports problems: mistranslations,
// omissions, unnatural or ungrammatical Chinese, and English a learner at the
// level couldn't translate. A major problem fails the check. Stored as
// `answerKeyCheck` (the reference is the exercise's answer key), with no
// per-question answers.

import type Anthropic from '@anthropic-ai/sdk';
import type { AnswerKeyCheck, TranslateExercise } from '@hanyu/shared';
import { closeObjects, costOf, MODEL, type Llm } from '../passages/llm.js';

export const CHECK_MODEL = MODEL;
/** Bump when the check's prompt or schema changes; `translate:check` reruns old checks. */
export const CHECK_PROMPT_VERSION = '1';

const SYSTEM = `You check English → Chinese translation exercises for adult learners of Mandarin Chinese before they are published. Learners at the given HSK level read the English and write it in Chinese; an automatic grader compares their Chinese with the reference translation.

Report problems:
- The reference mistranslates, drops, or adds anything compared with the English.
- The reference is ungrammatical or unnatural Chinese.
- The English is unnatural, ambiguous in a way that changes the Chinese, or needs vocabulary or knowledge clearly beyond the level to translate.

Mark a problem "major" only if it would mislead a learner or make the grading unfair; style preferences are "minor". Report nothing if there is nothing wrong.

Reply with one JSON object in the required format.`;

const SCHEMA = closeObjects({
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        properties: {
          severity: { type: 'string', enum: ['major', 'minor'] },
          description: { type: 'string' },
        },
      },
    },
  },
});

export function checkPrompt(
  exercise: Pick<TranslateExercise, 'level' | 'english' | 'reference'>,
) {
  return `HSK level: ${exercise.level === 7 ? '7–9' : exercise.level}\n\nEnglish:\n${exercise.english}\n\nReference translation:\n${exercise.reference}`;
}

export interface ReferenceCheckResult {
  check: AnswerKeyCheck;
  /** Why it failed, phrased for the generator to fix. Empty if it passed. */
  problems: string[];
  costUsd: number;
}

export async function checkReference(
  exercise: Pick<TranslateExercise, 'level' | 'english' | 'reference'>,
  { llm, now = () => new Date() }: { llm: Llm; now?: () => Date },
): Promise<ReferenceCheckResult> {
  const response = await llm.create({
    model: CHECK_MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: checkPrompt(exercise) }],
  } satisfies Anthropic.Messages.MessageCreateParamsNonStreaming);
  const costUsd = costOf(response.usage);
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let issues: AnswerKeyCheck['issues'];
  try {
    issues = (JSON.parse(text) as { issues: AnswerKeyCheck['issues'] }).issues;
  } catch {
    throw new Error(
      `The reference check's reply was not complete JSON (stop reason: ${response.stop_reason ?? 'unknown'})`,
    );
  }
  issues = issues ?? [];
  const problems = issues
    .filter((i) => i.severity === 'major')
    .map((i) => `A reviewer found a problem: ${i.description}`);
  return {
    check: {
      model: CHECK_MODEL,
      promptVersion: CHECK_PROMPT_VERSION,
      checkedAt: now().toISOString(),
      passed: problems.length === 0,
      answers: [],
      issues,
      costUsd: Math.round(costUsd * 10000) / 10000,
    },
    problems,
    costUsd,
  };
}

/** Whether an exercise needs (re)checking: never checked, or by an older prompt. */
export function needsCheck(
  exercise: Pick<TranslateExercise, 'answerKeyCheck'>,
) {
  return exercise.answerKeyCheck?.promptVersion !== CHECK_PROMPT_VERSION;
}
