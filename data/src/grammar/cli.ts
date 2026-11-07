// Writes English for the syllabus's grammar points into data/grammar-english.json.
//
//   npm run grammar:translate [-- --level 1] [--force] [--max-cost 2]
//
// Needs ANTHROPIC_API_KEY (in .env). Only points without English are sent
// (--force redoes them), so rerunning retries any that failed. Afterwards,
// npm run data:build merges them into data/seed and db:seed loads them.

import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { readGrammar } from '../parse/grammar.js';
import { MODEL } from '../passages/llm.js';
import {
  GRAMMAR_PROMPT_VERSION,
  readEnglish,
  translateGrammar,
  writeEnglish,
} from './english.js';

const BATCH_SIZE = 25;

const { values } = parseArgs({
  options: {
    level: { type: 'string' },
    'max-cost': { type: 'string', default: '2' },
    force: { type: 'boolean', default: false },
  },
});
const cap = Number(values['max-cost']);
if (!(cap > 0)) {
  console.error('--max-cost must be above 0');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY (in .env) to call the API.');
  process.exit(1);
}
const client = new Anthropic();

const english = readEnglish();
english.model = MODEL;
english.promptVersion = GRAMMAR_PROMPT_VERSION;

const level = values.level === undefined ? undefined : Number(values.level);
const todo = readGrammar().filter(
  (p) =>
    (level === undefined || p.level === level) &&
    (values.force || !english.points[p._id]),
);

let spent = 0;
let lastCost = 0;
let failed = 0;
for (let i = 0; i < todo.length; i += BATCH_SIZE) {
  if (spent + (lastCost || 0.05) > cap) {
    console.log(`Stopped: the next call could pass the $${cap} cap.`);
    break;
  }
  const batch = todo.slice(i, i + BATCH_SIZE);
  const result = await translateGrammar(batch, {
    create: (params) => client.messages.create(params),
  });
  lastCost = result.costUsd;
  spent += result.costUsd;
  Object.assign(english.points, result.english);
  writeEnglish(english);
  failed += result.problems.length;
  for (const { id, problem } of result.problems) {
    console.log(`${id}: ✗ ${problem}`);
  }
  console.log(
    `${Math.min(i + BATCH_SIZE, todo.length)}/${todo.length} ($${result.costUsd.toFixed(3)})`,
  );
}
console.log(`Spent about $${spent.toFixed(3)} of $${cap}.`);
if (failed) {
  console.log(`${failed} points failed. Rerun to retry them.`);
  process.exitCode = 1;
}
