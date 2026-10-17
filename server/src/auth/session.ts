import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { Types } from 'mongoose';
import { config } from '../config.js';
import { SessionModel } from '../models/session.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sessions expire after this long without use. */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Extend a session once less than this much of it remains. */
const RENEW_BELOW_MS = SESSION_TTL_MS - DAY_MS;

// `__Host-` makes browsers insist on Secure, Path=/, and no Domain, so a
// sibling subdomain can't plant a session cookie. It needs HTTPS, so only in
// production.
export const SESSION_COOKIE = config.isProduction
  ? '__Host-hanyu_session'
  : 'hanyu_session';

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    // The client is served from the same origin, so Strict costs nothing, and
    // it keeps other sites from making signed-in requests (CSRF).
    sameSite: 'strict',
    path: '/',
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function readToken(req: Request): string | null {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

function setCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
}

/** Starts a new session (a fresh token every sign-in) and sets its cookie. */
export async function startSession(res: Response, userId: Types.ObjectId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await SessionModel.create({ _id: hashToken(token), userId, expiresAt });
  setCookie(res, token, expiresAt);
}

/**
 * Returns the signed-in user's ID and session ID, or null. Sliding expiry:
 * a session in use is pushed back to a full TTL at most once a day.
 */
export async function resumeSession(
  req: Request,
  res: Response,
): Promise<{ sessionId: string; userId: Types.ObjectId } | null> {
  const token = readToken(req);
  if (!token) return null;
  const sessionId = hashToken(token);
  const session = await SessionModel.findOne({
    _id: sessionId,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!session) return null;

  if (session.expiresAt.getTime() - Date.now() < RENEW_BELOW_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await SessionModel.updateOne({ _id: sessionId }, { expiresAt });
    setCookie(res, token, expiresAt);
  }
  return { sessionId, userId: session.userId };
}

/** Deletes the caller's session, if any, and clears the cookie. */
export async function endSession(req: Request, res: Response) {
  const token = readToken(req);
  if (token) await SessionModel.deleteOne({ _id: hashToken(token) });
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
