// The automated answer-key check: a separate call answers a passage's
// questions from the text alone, without seeing the key, and reports
// problems. Disagreeing with the key, finding a second defensible option, or
// a major issue fails the check.

import type Anthropic from '@anthropic-ai/sdk';
import {
  checkClozeAnswer,
  CLOZE_BLANK,
  type AnswerKeyCheck,
  type Passage,
} from '@hanyu/shared';
import { closeObjects, costOf, MODEL, type Llm } from './llm.js';

export const CHECK_MODEL = MODEL;
/** Bump when the check's prompt or schema changes; `passages:check` reruns old checks. */
export const CHECK_PROMPT_VERSION = '1';

const SYSTEM = `You check reading-comprehension exercises for adult learners of Mandarin Chinese before they are published. You see a passage and its questions, but not the answer key.

1. Answer every question using only the passage, as a careful reader would.
   - Multiple choice: give the index (0–3) of the correct option. List any other option a careful reader could also defend as correct (usually none).
   - Fill in the blank: give the word that fills ${CLOZE_BLANK} in the sentence, guided by the passage and the English hint. List other words that would fit the blank just as well (often none).
2. Report problems with the passage or the questions: grammatical errors or unnatural Chinese, contradictions, questions the passage doesn't answer, or questions with no correct option. Mark a problem "major" only if it would mislead or confuse a learner; style preferences are "minor". Report nothing if there is nothing wrong.

Reply with one JSON object in the required format.`;

const SCHEMA = closeObjects({
  type: 'object',
  required: ['choiceAnswers', 'clozeAnswers', 'issues'],
  properties: {
    choiceAnswers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId', 'answer', 'alsoDefensible'],
        properties: {
          questionId: { type: 'string' },
          answer: { type: 'integer' },
          alsoDefensible: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    clozeAnswers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId', 'answer', 'alsoFits'],
        properties: {
          questionId: { type: 'string' },
          answer: { type: 'string' },
          alsoFits: { type: 'array', items: { type: 'string' } },
        },
      },
    },
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

interface CheckReply {
  choiceAnswers: {
    questionId: string;
    answer: number;
    alsoDefensible: number[];
  }[];
  clozeAnswers: { questionId: string; answer: string; alsoFits: string[] }[];
  issues: AnswerKeyCheck['issues'];
}

/** The exercise as the checker sees it: no answers, no explanations. */
export function checkPrompt(
  passage: Pick<Passage, 'title' | 'text' | 'questions'>,
) {
  const questions = passage.questions.map((q) =>
    q.type === 'choice'
      ? `${q.id} (multiple choice): ${q.prompt}\n${q.options.map((o, i) => `  ${i}. ${o}`).join('\n')}`
      : `${q.id} (fill in the blank): ${q.sentence}\n  Hint: ${q.hint}`,
  );
  return `Passage: ${passage.title}\n\n${passage.text}\n\nQuestions:\n\n${questions.join('\n\n')}`;
}

/** How a question is named in feedback to the generator. */
function questionName(passage: Pick<Passage, 'questions'>, id: string) {
  const question = passage.questions.find((q) => q.id === id)!;
  const n =
    passage.questions
      .filter((q) => q.type === question.type)
      .findIndex((q) => q.id === id) + 1;
  return question.type === 'choice'
    ? `Multiple-choice question ${n}`
    : `Cloze question ${n}`;
}

/** Compares the checker's answers with the key. */
export function evaluateCheck(
  passage: Pick<Passage, 'questions'>,
  reply: CheckReply,
): { answers: AnswerKeyCheck['answers']; problems: string[] } {
  const problems: string[] = [];
  const answers = passage.questions.map((q): AnswerKeyCheck['answers'][0] => {
    const name = questionName(passage, q.id);
    if (q.type === 'choice') {
      const given = reply.choiceAnswers?.find((a) => a.questionId === q.id);
      if (!given) {
        problems.push(`${name}: an independent reader couldn't answer it.`);
        return { questionId: q.id, given: '', agrees: false, alternatives: [] };
      }
      const alternatives = (given.alsoDefensible ?? [])
        .filter((i) => i !== given.answer && q.options[i] !== undefined)
        .map((i) => q.options[i]!);
      const agrees = given.answer === q.answer && alternatives.length === 0;
      if (given.answer !== q.answer) {
        problems.push(
          `${name}: an independent reader chose "${q.options[given.answer] ?? given.answer}", not the keyed answer "${q.options[q.answer]}". Make the passage and options point to one answer.`,
        );
      } else if (alternatives.length) {
        problems.push(
          `${name}: an independent reader found ${alternatives.map((a) => `"${a}"`).join(', ')} also defensible. Make only one option correct.`,
        );
      }
      return {
        questionId: q.id,
        given: q.options[given.answer] ?? String(given.answer),
        agrees,
        alternatives,
      };
    }
    const given = reply.clozeAnswers?.find((a) => a.questionId === q.id);
    if (!given) {
      problems.push(`${name}: an independent reader couldn't fill the blank.`);
      return { questionId: q.id, given: '', agrees: false, alternatives: [] };
    }
    const alternatives = (given.alsoFits ?? []).filter(
      (word) => !checkClozeAnswer(word, q),
    );
    const agrees = checkClozeAnswer(given.answer, q);
    if (!agrees) {
      problems.push(
        `${name}: an independent reader filled in "${given.answer}", not "${q.answer}". If "${given.answer}" fits as well, list it in alsoAccepted; otherwise choose a blank the context makes recoverable.`,
      );
    }
    return { questionId: q.id, given: given.answer, agrees, alternatives };
  });
  for (const issue of reply.issues ?? []) {
    if (issue.severity === 'major') {
      problems.push(`A reviewer found a problem: ${issue.description}`);
    }
  }
  return { answers, problems };
}

export interface AnswerKeyResult {
  check: AnswerKeyCheck;
  /** Why it failed, phrased for the generator to fix. Empty if it passed. */
  problems: string[];
  costUsd: number;
}

/** Runs the check on a passage (or a draft turned into one). */
export async function checkAnswerKey(
  passage: Pick<Passage, 'title' | 'text' | 'questions'>,
  { llm, now = () => new Date() }: { llm: Llm; now?: () => Date },
): Promise<AnswerKeyResult> {
  const response = await llm.create({
    model: CHECK_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: checkPrompt(passage) }],
  } satisfies Anthropic.Messages.MessageCreateParamsNonStreaming);
  const costUsd = costOf(response.usage);
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let reply: CheckReply;
  try {
    reply = JSON.parse(text) as CheckReply;
  } catch {
    throw new Error(
      `The answer-key check's reply was not complete JSON (stop reason: ${response.stop_reason ?? 'unknown'})`,
    );
  }
  const { answers, problems } = evaluateCheck(passage, reply);
  return {
    check: {
      model: CHECK_MODEL,
      promptVersion: CHECK_PROMPT_VERSION,
      checkedAt: now().toISOString(),
      passed: problems.length === 0,
      answers,
      issues: reply.issues ?? [],
      costUsd: Math.round(costUsd * 10000) / 10000,
    },
    problems,
    costUsd,
  };
}

/** Whether a passage needs (re)checking: never checked, or by an older prompt. */
export function needsCheck(passage: Pick<Passage, 'answerKeyCheck'>) {
  return passage.answerKeyCheck?.promptVersion !== CHECK_PROMPT_VERSION;
}
