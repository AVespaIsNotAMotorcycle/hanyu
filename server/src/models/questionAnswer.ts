import { model, Schema } from 'mongoose';

// Every answer to a reading or listening question: whether it was right and
// how it was given, never the answer itself. Append-only; progress
// (attempts, best grade) is derived from it.
const questionAnswerSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    // A passage (p1-0001) or listening exercise (l1-0001): their IDs never
    // collide.
    passageId: { type: String, required: true, immutable: true },
    questionId: { type: String, required: true, immutable: true },
    method: {
      type: String,
      enum: ['choice', 'typed', 'handwriting'],
      required: true,
      immutable: true,
    },
    correct: { type: Boolean, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

questionAnswerSchema.index({ userId: 1, passageId: 1, questionId: 1 });

export const QuestionAnswerModel = model(
  'QuestionAnswer',
  questionAnswerSchema,
);
