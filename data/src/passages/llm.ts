// The Anthropic API as the passage scripts use it: the model, its prices
// (shared with the server's grader), and the slice of the client they call
// (faked in tests).

import type Anthropic from '@anthropic-ai/sdk';

export {
  closeObjects,
  costOf,
  PRICING,
  SONNET as MODEL,
  type JsonSchema,
} from '@hanyu/shared';

/** The part of the Anthropic client the generator uses (fake in tests). */
export interface Llm {
  create(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ): Promise<
    Pick<Anthropic.Messages.Message, 'content' | 'usage' | 'stop_reason'>
  >;
}
