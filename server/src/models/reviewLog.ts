import { model, Schema, type InferSchemaType } from 'mongoose';

// Review logs are an append-only event stream, and card state is derived
// from them. The client generates each log's _id (a UUID), so syncing logs
// from several devices is a union by _id: re-sending a log is harmless.
const reviewLogSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    cardKey: { type: String, required: true, immutable: true },
    /** FSRS rating: 1 Again, 2 Hard, 3 Good, 4 Easy. */
    rating: { type: Number, required: true, min: 1, max: 4, immutable: true },
    reviewedAt: { type: Date, required: true, immutable: true },
    /** What the learner typed or drew, for later review of mistakes. */
    answer: { type: String, immutable: true },
    durationMs: { type: Number, min: 0, immutable: true },
    deviceId: { type: String, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

reviewLogSchema.index({ userId: 1, reviewedAt: 1 });
reviewLogSchema.index({ userId: 1, cardKey: 1, reviewedAt: 1 });

function rejectChange(): never {
  throw new Error('Review logs are append-only and cannot be modified');
}

reviewLogSchema.pre('save', function () {
  if (!this.isNew) rejectChange();
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
] as const) {
  reviewLogSchema.pre(op, rejectChange);
}

export type ReviewLog = InferSchemaType<typeof reviewLogSchema>;
export const ReviewLogModel = model('ReviewLog', reviewLogSchema);
