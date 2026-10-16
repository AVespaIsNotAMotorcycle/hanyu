import { model, Schema } from 'mongoose';

// Records which seed dataset version is loaded. One document, _id "seed".
const datasetMetaSchema = new Schema(
  {
    _id: { type: String, required: true },
    version: { type: String, required: true },
    contentHash: { type: String, required: true },
    seededAt: { type: Date, required: true },
  },
  { versionKey: false },
);

export const DatasetMetaModel = model(
  'DatasetMeta',
  datasetMetaSchema,
  'datasetmeta',
);
