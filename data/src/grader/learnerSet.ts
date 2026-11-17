// The learner-style eval sets: reference translations of in-app exercises
// with deliberately injected errors, which are the answer key, plus faithful
// paraphrases that should get no major errors. One set per direction: passage
// paragraphs (Chinese → English) and Translate exercises (English → Chinese).
// Built once with Claude (`npm run grader:learner-set`) and reviewed in git
// like the passages.

import {
  findSpan,
  paragraphs,
  type Passage,
  type TranslateExercise,
  type TranslationDirection,
} from '@hanyu/shared';
import { closeObjects, costOf, MODEL, type Llm } from '../passages/llm.js';

export const INJECTION_TYPES = [
  'wrong tense or aspect (e.g. present for a completed 了 action)',
  'dropped clause (leave a clause or phrase of the source untranslated)',
  'mistranslated word (one content word rendered as a wrong but plausible word)',
  'wrong number, time, or person (e.g. two → three, he → she, Tuesday → Thursday)',
] as const;

/** Mistakes learners make writing Chinese. */
export const EN_ZH_INJECTION_TYPES = [
  'wrong measure word (e.g. 一个书 for 一本书, or a missing measure word: 两书)',
  'wrong word order (e.g. a time or place phrase after the verb: 我去商店明天)',
  'wrong aspect or negation (drop or misuse 了 or 过, or 不 for 没)',
  'wrong word (one content word replaced by a plausible wrong one, e.g. 卖 for 买, 借 for 还)',
  'dropped clause (leave a clause or phrase of the English untranslated)',
] as const;

export const INJECTION_TYPES_BY_DIRECTION: Record<
  TranslationDirection,
  readonly string[]
> = { 'zh-en': INJECTION_TYPES, 'en-zh': EN_ZH_INJECTION_TYPES };

export interface InjectedError {
  type: string;
  /** In the corrupted translation; empty for a dropped clause. */
  translationSpan: string;
  /** The source span whose meaning was broken. */
  sourceSpan: string;
  description: string;
}

export interface LearnerItem {
  /** `p1-0004/1/injected` or `t1-0002/0/paraphrase` */
  id: string;
  /** Absent in the Chinese → English set. */
  direction?: TranslationDirection;
  /** A passage, or a Translate exercise. */
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

const SYSTEM_EN_ZH = `You build test cases for an automatic grader of learners' English → Chinese translations. You get an English paragraph and a correct reference translation into simplified Chinese.

Return two Chinese translations:
1. "injected": the reference with exactly the requested errors introduced, the way a learner of Chinese might make them. Change nothing else. For each error, quote translationSpan exactly from the injected translation (the characters that are now wrong; empty for a dropped clause) and sourceSpan exactly from the English source (the part whose meaning or grammar was broken).
2. "paraphrase": a different but fully faithful, grammatical, and natural Chinese translation: reword it (other words, other sentence structure), but keep every detail, number, and time right. It must have no errors.

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

export interface BuildResult {
  items: LearnerItem[];
  problems: string[];
  costUsd: number;
}

/** The two items for one passage paragraph (Chinese → English). */
export function buildParagraphItems(
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
): Promise<BuildResult> {
  return buildItems(
    {
      direction: 'zh-en',
      passageId: passage._id,
      paragraph,
      source: paragraphs(passage.text)[paragraph]!,
      reference: passage.translation![paragraph]!,
      types,
    },
    llm,
  );
}

/** The two items for one Translate exercise (English → Chinese). */
export function buildTranslateItems(
  {
    exercise,
    types,
  }: {
    exercise: Pick<TranslateExercise, '_id' | 'english' | 'reference'>;
    types: readonly string[];
  },
  llm: Llm,
): Promise<BuildResult> {
  return buildItems(
    {
      direction: 'en-zh',
      passageId: exercise._id,
      paragraph: 0,
      source: exercise.english,
      reference: exercise.reference,
      types,
    },
    llm,
  );
}

/**
 * The injected and paraphrase items for one text. `types` are the errors to
 * inject. Tries twice; returns no items if both replies have problems.
 */
async function buildItems(
  {
    direction,
    passageId,
    paragraph,
    source,
    reference,
    types,
  }: {
    direction: TranslationDirection;
    passageId: string;
    paragraph: number;
    source: string;
    reference: string;
    types: readonly string[];
  },
  llm: Llm,
): Promise<BuildResult> {
  const language = direction === 'zh-en' ? 'Chinese' : 'English';
  const content = `${language} source:\n${source}\n\nReference translation:\n${reference}\n\nErrors to inject:\n${types.map((t) => `- ${t}`).join('\n')}`;
  let costUsd = 0;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await llm.create({
      model: MODEL,
      max_tokens: 3000,
      system: direction === 'zh-en' ? SYSTEM : SYSTEM_EN_ZH,
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
    const base = {
      // The Chinese → English set predates directions; its items have none.
      ...(direction === 'en-zh' ? { direction } : {}),
      passageId,
      paragraph,
      source,
      reference,
    };
    return {
      items: [
        {
          id: `${passageId}/${paragraph}/injected`,
          ...base,
          translation: reply.injected.trim(),
          kind: 'injected',
          injected: reply.errors,
        },
        {
          id: `${passageId}/${paragraph}/paraphrase`,
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
