import { Router } from 'express';
import type { HealthResponse } from '@hanyu/shared';
import { isDbConnected } from '../db.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    db: isDbConnected() ? 'connected' : 'disconnected',
  };
  res.json(body);
});
