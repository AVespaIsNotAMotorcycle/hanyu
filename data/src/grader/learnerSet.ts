// The learner-style eval set: reference translations of in-app passages with
// deliberately injected errors, which are the answer key, plus faithful
// paraphrases that should get no major errors. Built once with Claude
// (`npm run grader:learner-set`) and reviewed in git like the passages.

import { findSpan, paragraphs, type Passage } from '@hanyu/shared';
import { closeObjects, costOf, MODEL, type Llm } from '../passages/llm.js';

export const INJECTION_TYPES = [
  'wrong tense or aspect (e.g. present for a completed 了 action)',
  'dropped clause (leave a clause or phrase of the source untranslated)',
  'mistranslated word (one content word rendered as a wrong but plausible word)',
  'wrong number, time, or person (e.g. two → three, he → she, Tuesday → Thursday)',
] as const;

export interface InjectedError {
  type: string;
  /** In the corrupted translation; empty for a dropped clause. */
  translationSpan: string;
  /** The source span whose meaning was broken. */
  sourceSpan: string;
  description: string;
}

export interface LearnerItem {
  /** `p1-0004/1/injected` */
  id: string;
  passageId: string;
  paragraph: number;
  source: string;
  reference: string;
  translation: string;
  kind: 'injected' | 'paraphrase';
  /** The answer key: empty for a paraphrase. */
  injected: InjectedError[];
}

const SYSTEM = `You build test cases for an automatic grader of learners' Chinese → English translations. You get a Chinese paragraph and a correct reference translation.

Return two English translations:
1. "injected": the reference with exactly the requested errors introduced, the way a learner might make them. Change nothing else. For each error, quote translationSpan exactly from the injected translation (the words that are now wrong; empty for a dropped clause) and sourceSpan exactly from the Chinese source (the part whose meaning was broken).
2. "paraphrase": a different but fully faithful and natural translation: reword it, but keep every detail, tense, number, and name right. It must have no errors.

Reply with one JSON object in the required format.`;

const SCHEMA = closeObjects({
  type: 'object',
  required: ['injected', 'errors', 'paraphrase'],
  properties: {
    injected: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'translationSpan', 'sourceSpan', 'description'],
        properties: {
          type: { type: 'string' },
          translationSpan: { type: 'string' },
          sourceSpan: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    paraphrase: { type: 'string' },
  },
});

interface Reply {
  injected: string;
  errors: InjectedError[];
  paraphrase: string;
}

/** Problems with a reply, or none. */
export function replyProblems(
  reply: Reply,
  {
    source,
    reference,
    count,
  }: { source: string; reference: string; count: number },
): string[] {
  const problems: string[] = [];
  if (!reply.injected?.trim() || reply.injected.trim() === reference.trim()) {
    problems.push('The injected translation must differ from the reference.');
  }
  if (!reply.paraphrase?.trim()) problems.push('The paraphrase is empty.');
  if (reply.errors?.length !== count) {
    problems.push(
      `Inject exactly ${count} errors (got ${reply.errors?.length ?? 0}).`,
    );
  }
  for (const error of reply.errors ?? []) {
    if (
      error.translationSpan &&
      findSpan(reply.injected, error.translationSpan) === null
    ) {
      problems.push(
        `"${error.translationSpan}" is not quoted exactly from the injected translation.`,
      );
    }
    if (!error.sourceSpan || !source.includes(error.sourceSpan)) {
      problems.push(
        `"${error.sourceSpan}" is not quoted exactly from the source.`,
      );
    }
  }
  return problems;
}

/**
 * The two items for one paragraph. `types` are the errors to inject. Tries
 * twice; returns no items if both replies have problems.
 */
export async function buildParagraphItems(
  {
    passage,
    paragraph,
    types,
  }: {
    passage: Pick<Passage, '_id' | 'text' | 'translation'>;
    paragraph: number;
    types: readonly string[];
  },
  llm: Llm,
): Promise<{ items: LearnerItem[]; problems: string[]; costUsd: number }> {
  const source = paragraphs(passage.text)[paragraph]!;
  const reference = passage.translation![paragraph]!;
  const content = `Chinese source:\n${source}\n\nReference translation:\n${reference}\n\nErrors to inject:\n${types.map((t) => `- ${t}`).join('\n')}`;
  let costUsd = 0;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await llm.create({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            attempt === 0
              ? content
              : `${content}\n\nYour last reply had these problems; avoid them:\n${problems.map((p) => `- ${p}`).join('\n')}`,
        },
      ],
    });
    costUsd += costOf(response.usage);
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let reply: Reply;
    try {
      reply = JSON.parse(text) as Reply;
    } catch {
      problems = ['The reply was not complete JSON.'];
      continue;
    }
    problems = replyProblems(reply, { source, reference, count: types.length });
    if (problems.length) continue;
    const base = { passageId: passage._id, paragraph, source, reference };
    return {
      items: [
        {
          id: `${passage._id}/${paragraph}/injected`,
          ...base,
          translation: reply.injected.trim(),
          kind: 'injected',
          injected: reply.errors,
        },
        {
          id: `${passage._id}/${paragraph}/paraphrase`,
          ...base,
          translation: reply.paraphrase.trim(),
          kind: 'paraphrase',
          injected: [],
        },
      ],
      problems: [],
      costUsd,
    };
  }
  return { items: [], problems, costUsd };
}
