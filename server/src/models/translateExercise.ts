import { model, Schema } from 'mongoose';

// Loaded from data/translate (generated offline, reviewed in git). _id is the
// exercise ID (t1-0001). The reference check and hand review are stored as
// given.
const translateExerciseSchema = new Schema(
  {
    _id: { type: String, required: true },
    level: { type: Number, required: true, min: 1, max: 7, index: true },
    english: { type: String, required: true },
    reference: { type: String, required: true },
    topic: { type: String, required: true },
    tokens: { type: [String], required: true },
    grammar: [
      {
        _id: false,
        grammarId: { type: String, required: true },
        example: { type: String, required: true },
      },
    ],
    verification: {
      tokens: Number,
      atOrBelowLevel: Number,
      share: Number,
      offLevel: [String],
    },
    answerKeyCheck: { type: Schema.Types.Mixed, required: true },
    review: { type: Schema.Types.Mixed, default: null },
    generation: {
      model: String,
      promptVersion: String,
      generatedAt: String,
      attempts: Number,
      costUsd: Number,
    },
  },
  { versionKey: false },
);

export const TranslateExerciseModel = model(
  'TranslateExercise',
  translateExerciseSchema,
);
