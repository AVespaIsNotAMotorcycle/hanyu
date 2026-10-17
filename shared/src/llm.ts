// The slice of the Anthropic Messages API that grading uses, typed
// structurally so this package needs no SDK (the server and data pipeline
// pass the real client; tests pass fakes), and what calls cost.

export const SONNET = 'claude-sonnet-5-5';

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

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costOf(usage: LlmUsage): number {
  return (
    (usage.input_tokens * PRICING.input +
      usage.output_tokens * PRICING.output +
      (usage.cache_creation_input_tokens ?? 0) * PRICING.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * PRICING.cacheRead) /
    1_000_000
  );
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

/** A single-turn call that replies with JSON matching a schema. */
export interface JsonCall {
  model: string;
  max_tokens: number;
  system: string;
  output_config: { format: { type: 'json_schema'; schema: JsonSchema } };
  messages: { role: 'user'; content: string }[];
}

export interface JsonReply {
  content: readonly { type: string; text?: string }[];
  usage: LlmUsage;
  stop_reason: string | null;
}

export interface JsonLlm {
  create(params: JsonCall): Promise<JsonReply>;
}

/** The reply's text, parsed as JSON. Throws if it was cut off or isn't JSON. */
export function replyJson<T>(reply: JsonReply): T {
  const text = reply.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `The reply was not complete JSON (stop reason: ${reply.stop_reason ?? 'unknown'})`,
    );
  }
}
