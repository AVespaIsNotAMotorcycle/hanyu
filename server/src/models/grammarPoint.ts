import type { GrammarPoint } from '@hanyu/shared';
import { model, Schema } from 'mongoose';

const grammarPointSchema = new Schema<GrammarPoint>(
  {
    _id: { type: String, required: true },
    level: { type: Number, required: true, min: 1, max: 7 },
    order: { type: Number, required: true },
    category: { type: String, required: true },
    name: { type: String, default: '' },
    item: { type: String, default: '' },
    content: { type: String, default: '' },
  },
  { versionKey: false },
);

grammarPointSchema.index({ level: 1, order: 1 }, { unique: true });

export const GrammarPointModel = model(
  'GrammarPoint',
  grammarPointSchema,
  'grammarpoints',
);
