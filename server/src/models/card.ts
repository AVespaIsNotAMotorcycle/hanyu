import { model, Schema, type InferSchemaType } from 'mongoose';

// A card is identified by a deterministic key (see cardKey in @hanyu/shared),
// so cards created offline on different devices merge. Scheduling state is not
// stored here: it is recomputed from the card's review logs.
const cardSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    noteType: { type: String, enum: ['word', 'character'], required: true },
    noteId: { type: String, required: true },
    kind: {
      type: String,
      enum: ['pinyin', 'meaning', 'handwriting'],
      required: true,
    },
  },
  { timestamps: true },
);

cardSchema.index({ userId: 1, key: 1 }, { unique: true });

export type Card = InferSchemaType<typeof cardSchema>;
export const CardModel = model('Card', cardSchema);
