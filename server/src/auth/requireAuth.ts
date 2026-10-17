import type { RequestHandler } from 'express';
import { UserModel, type UserDocument } from '../models/user.js';
import { endSession, resumeSession } from './session.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user?: UserDocument;
      sessionId?: string;
    }
  }
}

/**
 * Rejects requests without a valid session with 401. Mounted in front of
 * every API route except sign-up, sign-in, and sign-out.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const session = await resumeSession(req, res);
  const user = session && (await UserModel.findById(session.userId));
  if (!session || !user) {
    // A stale cookie (expired session, deleted user) is cleared so the
    // client stops sending it.
    if (req.headers.cookie) await endSession(req, res);
    res.status(401).json({ error: 'Sign in required' });
    return;
  }
  req.user = user;
  req.sessionId = session.sessionId;
  next();
};
