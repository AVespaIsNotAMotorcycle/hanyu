// Code shared by the client, server, and data pipeline.

import type { WordNote } from './content.js';

export * from './auth.js';
export * from './content.js';
export * from './pinyin.js';
export * from './pinyinAnswer.js';
export * from './scheduling.js';

export interface WordSampleResponse {
  word: WordNote;
}

export interface HealthResponse {
  status: 'ok';
  db: 'connected' | 'disconnected';
}
