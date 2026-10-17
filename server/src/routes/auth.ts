import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  DISPLAY_NAME_MAX_LENGTH,
  isPlausibleEmail,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type AuthResponse,
} from '@hanyu/shared';
import { mongo } from 'mongoose';
import {
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from '../auth/password.js';
import { requireAuth } from '../auth/requireAuth.js';
import { endSession, startSession } from '../auth/session.js';
import { toAuthUser, UserModel } from '../models/user.js';

const MINUTE_MS = 60 * 1000;

function limiter(windowMs: number, limit: number, error: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Only failures count, so a learner signing in normally is never blocked.
    skipSuccessfulRequests: true,
    message: { error },
  });
}

function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * Sign-up, sign-in, and sign-out are the only API routes reachable without a
 * session. A factory so each app (and each test) gets its own rate limiters.
 */
export function createAuthRouter() {
  const router = Router();

  router.post(
    '/sign-up',
    limiter(60 * MINUTE_MS, 10, 'Too many sign-up attempts; try again later'),
    async (req, res) => {
      const { email, password, displayName } = req.body ?? {};
      if (
        typeof email !== 'string' ||
        !isPlausibleEmail(normalizeEmail(email))
      ) {
        throw badRequest('A valid email address is required');
      }
      const problem = passwordProblem(password);
      if (problem) throw badRequest(problem);
      if (
        displayName !== undefined &&
        (typeof displayName !== 'string' ||
          displayName.length > DISPLAY_NAME_MAX_LENGTH)
      ) {
        throw badRequest(
          `Display name must be text of at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
        );
      }

      let user;
      try {
        user = await UserModel.create({
          email: normalizeEmail(email),
          passwordHash: await hashPassword(password),
          displayName: displayName?.trim() || undefined,
        });
      } catch (err) {
        if (err instanceof mongo.MongoServerError && err.code === 11000) {
          res
            .status(409)
            .json({ error: 'An account with this email already exists' });
          return;
        }
        throw err;
      }

      await startSession(res, user._id);
      const body: AuthResponse = { user: toAuthUser(user) };
      res.status(201).json(body);
    },
  );

  router.post(
    '/sign-in',
    limiter(
      15 * MINUTE_MS,
      10,
      'Too many failed sign-in attempts; try again later',
    ),
    async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw badRequest('Email and password are required');
      }
      const user =
        password.length <= PASSWORD_MAX_LENGTH
          ? await UserModel.findOne({ email: normalizeEmail(email) }).select(
              '+passwordHash',
            )
          : null;
      const valid = user
        ? await verifyPassword(password, user.passwordHash)
        : await verifyAgainstDummy(password.slice(0, PASSWORD_MAX_LENGTH));
      if (!user || !valid) {
        res.status(401).json({ error: 'Incorrect email or password' });
        return;
      }

      await startSession(res, user._id);
      const body: AuthResponse = { user: toAuthUser(user) };
      res.json(body);
    },
  );

  // Public so that a client with an expired session can still clear its
  // cookie; it only ever ends the caller's own session.
  router.post('/sign-out', async (req, res) => {
    await endSession(req, res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    const body: AuthResponse = { user: toAuthUser(req.user!) };
    res.json(body);
  });

  return router;
}
