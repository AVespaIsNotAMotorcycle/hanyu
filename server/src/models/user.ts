import {
  DEFAULT_DAILY_NEW_CARDS,
  DEFAULT_HANDWRITING,
  DEFAULT_LEVELS,
  MAX_ALLOWED_MISSES,
  MAX_DAILY_NEW_CARDS,
  type AuthUser,
  type HandwritingSettings,
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
      handwriting: {
        enabled: { type: Boolean, default: DEFAULT_HANDWRITING.enabled },
        strokeOrder: {
          type: String,
          enum: ['strict', 'lenient'],
          default: DEFAULT_HANDWRITING.strokeOrder,
        },
        allowedMisses: {
          type: Number,
          min: 0,
          max: MAX_ALLOWED_MISSES,
          default: DEFAULT_HANDWRITING.allowedMisses,
        },
      },
      /** Word IDs added from reading, oldest first. */
      addedWords: { type: [String], default: () => [] },
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
      handwriting: {
        enabled:
          user.settings?.handwriting?.enabled ?? DEFAULT_HANDWRITING.enabled,
        strokeOrder: (user.settings?.handwriting?.strokeOrder ??
          DEFAULT_HANDWRITING.strokeOrder) as HandwritingSettings['strokeOrder'],
        allowedMisses:
          user.settings?.handwriting?.allowedMisses ??
          DEFAULT_HANDWRITING.allowedMisses,
      },
      addedWords: [...(user.settings?.addedWords ?? [])],
    },
  };
}
