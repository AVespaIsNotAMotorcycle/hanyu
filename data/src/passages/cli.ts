// Passage generation and coverage CLI.
//
//   npm run passages:generate -- --level 1 [--count 5] [--max-cost 5]
//                                [--grammar g1-008,g1-020] [--dry-run]
//   npm run passages:coverage [-- --level 1]
//
// Generation needs ANTHROPIC_API_KEY (in .env). It writes passages to
// data/passages/hsk<level>/ for review; `npm run db:seed` loads them.

import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { HSK_LEVELS, isHskLevel, type HskLevel } from '@hanyu/shared';
import { createSegmenter } from '../segmenter.js';
import { loadSeedContent } from './content.js';
import {
  generatePassage,
  MODEL,
  systemPrompt,
  userPrompt,
  type Llm,
} from './generate.js';
import {
  grammarCoverage,
  nextPassageId,
  readPassages,
  writePassage,
} from './library.js';

const TARGETS_PER_PASSAGE = 2;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    level: { type: 'string' },
    count: { type: 'string', default: '1' },
    'max-cost': { type: 'string', default: '5' },
    grammar: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const command = positionals[0];
const content = loadSeedContent();

function levelArg(required: boolean): HskLevel | undefined {
  if (values.level === undefined && !required) return undefined;
  const level = Number(values.level);
  if (!isHskLevel(level)) {
    console.error('--level must be 1 to 7 (7 = levels 7–9)');
    process.exit(1);
  }
  return level;
}

if (command === 'coverage') {
  const only = levelArg(false);
  for (const level of only ? [only] : HSK_LEVELS) {
    const passages = readPassages(level);
    const coverage = grammarCoverage(content.grammar, passages, level);
    const covered = coverage.filter((c) => c.passages > 0).length;
    console.log(
      `HSK ${level}: ${passages.length} passages, ${covered}/${coverage.length} grammar points covered`,
    );
    if (only) {
      for (const { point, passages: n } of coverage) {
        console.log(
          `  ${String(n).padStart(3)}  ${point._id}  ${[point.name, point.item].filter(Boolean).join(' / ')}  ${point.content ?? ''}`,
        );
      }
    }
  }
} else if (command === 'generate') {
  const level = levelArg(true)!;
  const count = Number(values.count);
  const cap = Number(values['max-cost']);
  if (!(count >= 1) || !(cap > 0)) {
    console.error('--count must be at least 1 and --max-cost above 0');
    process.exit(1);
  }
  const chosen = values.grammar?.split(',').map((id) => id.trim());
  for (const id of chosen ?? []) {
    if (!content.grammar.some((g) => g._id === id && g.level === level)) {
      console.error(`${id} is not a level-${level} grammar point`);
      process.exit(1);
    }
  }

  const passages = readPassages(level);
  const pickTargets = () =>
    chosen
      ? content.grammar.filter((g) => chosen.includes(g._id))
      : grammarCoverage(content.grammar, passages, level)
          .slice(0, TARGETS_PER_PASSAGE)
          .map((c) => c.point);

  if (values['dry-run']) {
    console.log(systemPrompt(level, content)[0]!.text);
    console.log('\n---\n');
    console.log(userPrompt(level, pickTargets()));
    process.exit(0);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY (in .env) to generate passages.');
    process.exit(1);
  }

  const client = new Anthropic();
  const llm: Llm = { create: (params) => client.messages.create(params) };
  const segmenter = createSegmenter(content.wordLevels.keys());
  let spent = 0;
  let written = 0;
  for (let i = 0; i < count; i++) {
    const targets = pickTargets();
    const id = nextPassageId(passages, level);
    console.log(
      `${id}: ${targets.map((t) => `${t._id} ${t.name}${t.item ? `/${t.item}` : ''}`).join(', ')}`,
    );
    const result = await generatePassage({
      id,
      level,
      targets,
      content,
      segmenter,
      llm,
      budgetUsd: cap - spent,
    });
    spent += result.costUsd;
    if (result.passage) {
      passages.push(result.passage);
      written++;
      const v = result.passage.verification;
      console.log(
        `  ✓ ${writePassage(result.passage)} (${(v.share * 100).toFixed(1)}% at level, ${result.attempts} attempt(s), $${result.costUsd.toFixed(3)})`,
      );
    } else if (result.outOfBudget) {
      console.log(`  Stopped: the next call could pass the $${cap} cap.`);
      break;
    } else {
      console.log(`  ✗ Gave up after ${result.attempts} attempts:`);
      for (const p of result.problems) console.log(`    - ${p}`);
    }
  }
  console.log(
    `${written} passage(s) written with ${MODEL}; spent about $${spent.toFixed(3)} of $${cap}.`,
  );
} else {
  console.error(
    'Usage: cli.ts generate --level N [...] | coverage [--level N]',
  );
  process.exit(1);
}
