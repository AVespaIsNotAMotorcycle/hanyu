import { model, Schema } from 'mongoose';

// Recorded audio, loaded from data/audio by the seed script. _id is the clip
// key (`word:hsk30-00001`, `passage:p1-0001:p0`; see audioKeys in shared);
// hash identifies the recording and serves as its ETag.
const audioClipSchema = new Schema(
  {
    _id: { type: String, required: true },
    hash: { type: String, required: true },
    voice: { type: String, required: true },
    data: { type: Buffer, required: true },
  },
  { versionKey: false },
);

export const AudioClipModel = model('AudioClip', audioClipSchema);
