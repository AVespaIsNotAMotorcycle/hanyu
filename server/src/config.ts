const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: Number(process.env.PORT ?? 5000),
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/hanyu',
  /** Translation grading is off without it. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  /** Daily reminders are off without these. */
  vapid:
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
      ? {
          publicKey: process.env.VAPID_PUBLIC_KEY,
          privateKey: process.env.VAPID_PRIVATE_KEY,
          subject: process.env.VAPID_SUBJECT,
        }
      : null,
  grading: {
    /** Gradings per user in any 24 hours. */
    dailyLimit: Number(process.env.GRADING_DAILY_LIMIT ?? 20),
    /** Spending cap across all users per calendar month (UTC). */
    monthlyBudgetUsd: Number(process.env.GRADING_MONTHLY_BUDGET_USD ?? 10),
  },
};
