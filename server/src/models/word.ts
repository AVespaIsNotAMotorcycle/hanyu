import type { WordNote } from '@hanyu/shared';
import { model, Schema } from 'mongoose';

// Seeded from data/seed/words.json. IDs are stable syllabus IDs (hsk30-00001),
// so cards can reference them across reseeds.
const wordSchema = new Schema<WordNote>(
  {
    _id: { type: String, required: true },
    hskId: { type: Number, required: true, unique: true },
    level: { type: Number, required: true, min: 1, max: 7 },
    levelLabel: { type: String, required: true },
    simplified: { type: String, required: true, index: true },
    traditional: { type: String, required: true, index: true },
    traditionalVariants: [String],
    homograph: { type: Number, default: null },
    pinyin: { type: String, required: true },
    citationPinyin: { type: String, required: true },
    alternatePinyin: [String],
    syllables: {
      type: [
        { _id: false, simplified: String, traditional: String, pinyin: String },
      ],
      default: null,
    },
    partsOfSpeech: [String],
    definitions: [String],
    zipf: { type: Number, required: true },
    levelOrder: { type: Number, required: true },
    characters: { type: [String], index: true },
    cedictMatch: {
      type: String,
      enum: ['exact', 'tones-differ', 'none'],
      required: true,
    },
  },
  { versionKey: false },
);

wordSchema.index({ level: 1, levelOrder: 1 });

export const WordModel = model('Word', wordSchema);
