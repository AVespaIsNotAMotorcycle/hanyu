import type {
  CharacterDetails,
  CharacterNote,
  CharacterStrokes,
} from '@hanyu/shared';
import { model, Schema } from 'mongoose';

export type CharacterDoc = CharacterNote &
  Omit<CharacterDetails, '_id'> &
  Omit<CharacterStrokes, '_id'>;

// Make Me a Hanzi etymology. It has a field named "type", so this schema uses
// "$type" to declare field types.
const etymologySchema = new Schema(
  {
    type: { $type: String, required: true },
    hint: { $type: String },
    phonetic: { $type: String },
    semantic: { $type: String },
  },
  { _id: false, typeKey: '$type' },
);

// Merged from data/seed/characters.json, character-details.json (Make Me a
// Hanzi, LGPL), and strokes.json (Make Me a Hanzi, Arphic PL). _id is the
// simplified character.
const characterSchema = new Schema<CharacterDoc>(
  {
    _id: { type: String, required: true },
    traditional: [String],
    readings: [String],
    introLevel: { type: Number, required: true, min: 1, max: 7 },
    introducedBy: { type: String, required: true, ref: 'Word' },
    introOrder: { type: Number, required: true, unique: true },
    hskReadLevel: { type: Number, default: null },
    hskWriteLevel: { type: Number, default: null },
    definition: { type: String, default: null },
    radical: { type: String, default: null },
    decomposition: { type: String, default: null },
    etymology: { type: etymologySchema, default: null },
    strokes: [String],
    medians: [[[Number]]],
  },
  { versionKey: false },
);

export const CharacterModel = model('Character', characterSchema);
