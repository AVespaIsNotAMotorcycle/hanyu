import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { requireAuth } from './auth/requireAuth.js';
import { createAuthRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { studyRouter } from './routes/study.js';

const clientDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../client/dist',
);

export interface AppOptions {
  /** Serve the React build from client/dist (production). */
  serveClient?: boolean;
  /**
   * Trust one proxy hop for X-Forwarded-For (Heroku's router), so rate limits
   * see the client's IP instead of the router's.
   */
  trustProxy?: boolean;
}

export function createApp({
  serveClient = false,
  trustProxy = false,
}: AppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json());

  const api = express.Router();
  api.use('/auth', createAuthRouter());
  // Everything below requires a signed-in user.
  api.use(requireAuth);
  api.use('/health', healthRouter);
  api.use('/settings', settingsRouter);
  api.use(studyRouter);
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', api);

  // In production, one dyno serves both the API and the React build.
  if (serveClient) {
    app.use(express.static(clientDist));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    // Client errors that are safe to show: validation failures thrown by
    // routes, and malformed or oversized JSON from express.json().
    const status = Number(err?.status);
    if (err?.expose && status >= 400 && status < 500) {
      res.status(status).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
