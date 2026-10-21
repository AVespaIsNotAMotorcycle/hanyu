import { model, Schema } from 'mongoose';

// Loaded from data/listening (generated offline, reviewed in git). _id is the
// exercise ID (l1-0001). Questions are multiple choice, validated by the
// generator, so they're stored as given, as are the answer-key check and the
// hand review.
const listeningExerciseSchema = new Schema(
  {
    _id: { type: String, required: true },
    level: { type: Number, required: true, min: 1, max: 7, index: true },
    text: { type: String, required: true },
    textEnglish: { type: String, required: true },
    topic: { type: String, required: true },
    names: [String],
    grammar: [
      {
        _id: false,
        grammarId: { type: String, required: true },
        example: { type: String, required: true },
      },
    ],
    questions: { type: [Schema.Types.Mixed], required: true },
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

export const ListeningExerciseModel = model(
  'ListeningExercise',
  listeningExerciseSchema,
);
