import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb } from './db.js';

await connectDb(config.mongodbUri);

// The only LLM calls the web app makes: translation grading.
const anthropic = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : null;
if (!anthropic) console.warn('ANTHROPIC_API_KEY is not set: grading is off.');

const app = createApp({
  serveClient: config.isProduction,
  trustProxy: config.isProduction,
  grading: {
    llm: anthropic && { create: (params) => anthropic.messages.create(params) },
    ...config.grading,
  },
});

app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});
