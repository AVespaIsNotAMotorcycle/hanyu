import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express, { type ErrorRequestHandler } from 'express';
import { requireAuth } from './auth/requireAuth.js';
import { createAuthRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { reviewsRouter } from './routes/reviews.js';
import { settingsRouter } from './routes/settings.js';
import { contentRouter } from './routes/content.js';
import { passagesRouter } from './routes/passages.js';
import {
  createTranslationsRouter,
  type GradingOptions,
} from './routes/translations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');
// License texts for the data sent to browsers (stroke data must travel with
// the Arphic Public License).
const licenses = path.resolve(here, '../../data/seed/LICENSES');

export interface AppOptions {
  /** Serve the React build from client/dist (production). */
  serveClient?: boolean;
  /**
   * Trust one proxy hop for X-Forwarded-For (Heroku's router), so rate limits
   * see the client's IP instead of the router's.
   */
  trustProxy?: boolean;
  /** Translation grading. Off (no LLM) unless given. */
  grading?: GradingOptions;
}

export function createApp({
  serveClient = false,
  trustProxy = false,
  grading = { llm: null, dailyLimit: 20, monthlyBudgetUsd: 10 },
}: AppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');
  // Word lists for the offline cache compress about 6×.
  app.use(compression());
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json());

  const api = express.Router();
  api.use('/auth', createAuthRouter());
  // Everything below requires a signed-in user.
  api.use(requireAuth);
  api.use('/health', healthRouter);
  api.use('/reviews', reviewsRouter);
  api.use('/settings', settingsRouter);
  api.use(contentRouter);
  api.use('/passages', passagesRouter);
  api.use('/translations', createTranslationsRouter(grading));
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', api);
  app.use('/licenses', express.static(licenses));

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
