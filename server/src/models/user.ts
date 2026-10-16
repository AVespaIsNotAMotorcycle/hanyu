import { model, Schema, type InferSchemaType } from 'mongoose';

// Credentials are not modeled yet: the authentication method is still an open
// decision in ROADMAP.md.
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    displayName: { type: String, trim: true },
    settings: {
      dailyNewCards: { type: Number, default: 10, min: 0 },
    },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);
