// The Anthropic API as the passage scripts use it: the model, its prices,
// and the slice of the client they call (faked in tests).

import type Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-sonnet-5-5';

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

export type JsonSchema = { [key: string]: unknown };

/** Structured outputs requires additionalProperties: false on every object. */
export function closeObjects(schema: JsonSchema): JsonSchema {
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
