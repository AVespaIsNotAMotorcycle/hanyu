import { model, Schema, type InferSchemaType } from 'mongoose';

// A signed-in browser. The cookie holds a random token; only its SHA-256 is
// stored (as _id), so a leaked database doesn't hand out live sessions.
const sessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// MongoDB deletes expired sessions (the TTL monitor runs about once a minute,
// so lookups also check expiresAt).
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type Session = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model('Session', sessionSchema);
