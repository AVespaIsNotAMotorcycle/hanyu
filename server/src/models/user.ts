import {
  DEFAULT_DAILY_NEW_CARDS,
  DEFAULT_LEVELS,
  MAX_DAILY_NEW_CARDS,
  type AuthUser,
  type HskLevel,
} from '@hanyu/shared';
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
      dailyNewCards: {
        type: Number,
        default: DEFAULT_DAILY_NEW_CARDS,
        min: 0,
        max: MAX_DAILY_NEW_CARDS,
      },
      levels: {
        type: [{ type: Number, min: 1, max: 7 }],
        default: () => [...DEFAULT_LEVELS],
      },
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
    settings: {
      dailyNewCards: user.settings?.dailyNewCards ?? DEFAULT_DAILY_NEW_CARDS,
      levels: (user.settings?.levels ?? DEFAULT_LEVELS) as HskLevel[],
    },
  };
}
