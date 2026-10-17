import { model, Schema } from 'mongoose';

// Loaded from data/passages (generated offline, reviewed in git). _id is the
// passage ID (p1-0001). Questions are a union of choice and cloze shapes,
// validated by the generator, so they're stored as given.
const passageSchema = new Schema(
  {
    _id: { type: String, required: true },
    level: { type: Number, required: true, min: 1, max: 7, index: true },
    title: { type: String, required: true },
    titleEnglish: { type: String, required: true },
    text: { type: String, required: true },
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

export const PassageModel = model('Passage', passageSchema);
