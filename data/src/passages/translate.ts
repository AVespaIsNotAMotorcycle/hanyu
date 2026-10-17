// Reference translations: one English paragraph per Chinese paragraph, the
// model answer translation exercises are graded against.

import { paragraphs, type Passage } from '@hanyu/shared';
import { closeObjects, costOf, MODEL, type Llm } from './llm.js';

const SYSTEM = `You translate short Chinese reading passages for adult learners into English. Your translations are the reference answers learners' own translations are compared with, so make each one faithful (every detail, no additions, tenses and numbers right) and natural, plain English. Keep names in pinyin (小明 → Xiaoming). Translate each paragraph separately, in order.

Reply with one JSON object in the required format.`;

const SCHEMA = closeObjects({
  type: 'object',
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array',
      items: { type: 'string' },
      description: 'One English paragraph per Chinese paragraph, in order',
    },
  },
});

export interface TranslateResult {
  /** Null if the reply didn't have one paragraph per paragraph. */
  translation: string[] | null;
  problem: string | null;
  costUsd: number;
}

export async function translatePassage(
  passage: Pick<Passage, 'title' | 'text'>,
  llm: Llm,
): Promise<TranslateResult> {
  const source = paragraphs(passage.text);
  const response = await llm.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: source.map((p, i) => `Paragraph ${i + 1}:\n${p}`).join('\n\n'),
      },
    ],
  });
  const costUsd = costOf(response.usage);
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let reply: { paragraphs?: string[] };
  try {
    reply = JSON.parse(text) as { paragraphs?: string[] };
  } catch {
    return {
      translation: null,
      problem: `The reply was not complete JSON (stop reason: ${response.stop_reason ?? 'unknown'})`,
      costUsd,
    };
  }
  const translation = (reply.paragraphs ?? []).map((p) => p.trim());
  if (translation.length !== source.length || translation.some((p) => !p)) {
    return {
      translation: null,
      problem: `Expected ${source.length} translated paragraphs, got ${translation.filter(Boolean).length}`,
      costUsd,
    };
  }
  return { translation, problem: null, costUsd };
}
