import { model, Schema, type InferSchemaType } from 'mongoose';

// Every translation grading, logged: what was graded, what the grader said,
// and what it cost. A grading is stored as `pending` before the LLM call (so
// concurrent requests count against the daily limit) and completed once.
const translationGradingSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    passageId: { type: String, required: true, immutable: true },
    paragraph: { type: Number, required: true, immutable: true },
    source: { type: String, required: true, immutable: true },
    reference: { type: String, required: true, immutable: true },
    translation: { type: String, required: true, immutable: true },
    status: {
      type: String,
      enum: ['pending', 'graded', 'failed'],
      required: true,
    },
    /** GradingResult, once graded. */
    result: { type: Schema.Types.Mixed, default: null },
    /** Why grading failed. */
    error: { type: String, default: null },
    model: { type: String, required: true },
    promptVersion: { type: String, required: true },
    usage: { type: Schema.Types.Mixed, default: null },
    costUsd: { type: Number, default: 0 },
    /** Word IDs added to the user's SRS from the grader's mistranslatedWords. */
    addedWords: { type: [String], default: () => [] },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

translationGradingSchema.index({ userId: 1, createdAt: 1 });
translationGradingSchema.index({ userId: 1, passageId: 1, createdAt: -1 });
// The monthly budget sums cost across users.
translationGradingSchema.index({ createdAt: 1 });

export type TranslationGradingDoc = InferSchemaType<
  typeof translationGradingSchema
>;
export const TranslationGradingModel = model(
  'TranslationGrading',
  translationGradingSchema,
);
