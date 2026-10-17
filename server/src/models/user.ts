import type { AuthUser } from '@hanyu/shared';
import {
  model,
  Schema,
  type HydratedDocument,
  type InferSchemaType,
} from 'mongoose';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    /** `scrypt$N$r$p$salt$hash`; see auth/password.ts. Never selected by default. */
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, trim: true },
    settings: {
      dailyNewCards: { type: Number, default: 10, min: 0 },
    },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;
export const UserModel = model('User', userSchema);

/** The fields the client may see. */
export function toAuthUser(user: UserDocument): AuthUser {
  return {
    id: user.id as string,
    email: user.email,
    displayName: user.displayName ?? null,
    settings: { dailyNewCards: user.settings?.dailyNewCards ?? 10 },
  };
}
