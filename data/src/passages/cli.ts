// Passage generation, checking, review, and coverage CLI.
//
//   npm run passages:generate -- --level 1 [--count 5] [--max-cost 5]
//                                [--grammar g1-008,g1-020] [--dry-run]
//   npm run passages:check [-- --level 1] [--force] [--max-cost 1]
//   npm run passages:translate [-- --level 1] [--force] [--max-cost 1]
//   npm run passages:review [-- --level 1] [--sample 3]
//   npm run passages:coverage [-- --level 1]
//
// Generation and checking need ANTHROPIC_API_KEY (in .env). Passages are
// written to data/passages/hsk<level>/ for review; `npm run db:seed` loads them.

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { HSK_LEVELS, isHskLevel, type HskLevel } from '@hanyu/shared';
import { createSegmenter } from '../segmenter.js';
import { checkAnswerKey, needsCheck } from './answerKey.js';
import { loadSeedContent } from './content.js';
import {
  generatePassage,
  MODEL,
  systemPrompt,
  userPrompt,
  type Llm,
} from './generate.js';
import { tokenize } from './level.js';
import {
  deletePassage,
  grammarCoverage,
  libraryStatus,
  nextPassageId,
  pickSample,
  readPassages,
  writePassage,
} from './library.js';
import { formatForReview } from './review.js';
import { translatePassage } from './translate.js';

const TARGETS_PER_PASSAGE = 2;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    level: { type: 'string' },
    count: { type: 'string', default: '1' },
    'max-cost': { type: 'string' },
    grammar: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    sample: { type: 'string', default: '3' },
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

function costCap(fallback: number): number {
  const cap = Number(values['max-cost'] ?? fallback);
  if (!(cap > 0)) {
    console.error('--max-cost must be above 0');
    process.exit(1);
  }
  return cap;
}

function anthropic(): Llm {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY (in .env) to call the API.');
    process.exit(1);
  }
  const client = new Anthropic();
  return { create: (params) => client.messages.create(params) };
}

const levelsArg = () => {
  const only = levelArg(false);
  return only ? [only] : HSK_LEVELS;
};

if (command === 'coverage') {
  const only = levelArg(false);
  for (const level of only ? [only] : HSK_LEVELS) {
    const passages = readPassages(level);
    const coverage = grammarCoverage(content.grammar, passages, level);
    const covered = coverage.filter((c) => c.passages > 0).length;
    const status = libraryStatus(passages);
    console.log(
      `HSK ${level}: ${passages.length} passages (${status.checked} passed the answer-key check${status.failed ? `, ${status.failed} failed` : ''}, ${status.reviewed} reviewed by hand), ${covered}/${coverage.length} grammar points covered`,
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
  const cap = costCap(5);
  if (!(count >= 1)) {
    console.error('--count must be at least 1');
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
  const llm = anthropic();
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
} else if (command === 'check') {
  // Brings stored passages up to date: segmentation for tap-to-look-up
  // (free), and the answer-key check where it's missing or out of date
  // (--force reruns it everywhere).
  const cap = costCap(1);
  const segmenter = createSegmenter(content.wordLevels.keys());
  let llm: Llm | null = null;
  let spent = 0;
  let lastCost = 0;
  const failed: string[] = [];
  run: for (const level of levelsArg()) {
    for (const passage of readPassages(level)) {
      // Segmentation is free and deterministic, so it's always redone.
      const tokens = tokenize(passage.text, {
        segmenter,
        wordLevels: content.wordLevels,
        names: passage.names,
      });
      let changed = JSON.stringify(tokens) !== JSON.stringify(passage.tokens);
      passage.tokens = tokens;
      if (needsCheck(passage) || values.force) {
        if (spent + (lastCost || 0.02) > cap) {
          console.log(`Stopped: the next check could pass the $${cap} cap.`);
          if (changed) writePassage(passage);
          break run;
        }
        llm ??= anthropic();
        const result = await checkAnswerKey(passage, { llm });
        lastCost = result.costUsd;
        spent += result.costUsd;
        passage.answerKeyCheck = result.check;
        changed = true;
        console.log(
          `${passage._id}: ${result.check.passed ? '✓ passed' : '✗ failed'} ($${result.costUsd.toFixed(3)})`,
        );
        for (const p of result.problems) console.log(`  - ${p}`);
      }
      if (passage.answerKeyCheck?.passed === false) failed.push(passage._id);
      if (changed) writePassage(passage);
    }
  }
  console.log(`Spent about $${spent.toFixed(3)} of $${cap}.`);
  if (failed.length) {
    console.log(
      `Failed the answer-key check (db:seed refuses them; regenerate or delete): ${failed.join(', ')}`,
    );
  }
} else if (command === 'translate') {
  // Reference translations for translation exercises, where missing
  // (--force redoes them).
  const cap = costCap(1);
  let llm: Llm | null = null;
  let spent = 0;
  let lastCost = 0;
  run: for (const level of levelsArg()) {
    for (const passage of readPassages(level)) {
      if (passage.translation && !values.force) continue;
      if (spent + (lastCost || 0.02) > cap) {
        console.log(`Stopped: the next call could pass the $${cap} cap.`);
        break run;
      }
      llm ??= anthropic();
      const result = await translatePassage(passage, llm);
      lastCost = result.costUsd;
      spent += result.costUsd;
      if (result.translation) {
        passage.translation = result.translation;
        writePassage(passage);
        console.log(`${passage._id}: ✓ ($${result.costUsd.toFixed(3)})`);
      } else {
        console.log(`${passage._id}: ✗ ${result.problem}`);
      }
    }
  }
  console.log(`Spent about $${spent.toFixed(3)} of $${cap}.`);
} else if (command === 'review') {
  // Spot-check a random sample of passages that passed the automated checks.
  const sample = Number(values.sample);
  if (!(sample >= 1)) {
    console.error('--sample must be at least 1');
    process.exit(1);
  }
  const chosen = pickSample(
    levelsArg().flatMap((l) => readPassages(l)),
    sample,
  );
  if (!chosen.length) {
    console.log(
      'Nothing to review: every passage that passed the answer-key check has been reviewed.',
    );
    process.exit(0);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, passage] of chosen.entries()) {
      console.log(`\n──── ${i + 1} of ${chosen.length} ────\n`);
      console.log(formatForReview(passage));
      const choice = (
        await rl.question('\n[a]pprove, [d]elete, [s]kip, or [q]uit? ')
      )
        .trim()
        .toLowerCase();
      if (choice === 'q') break;
      if (choice === 'a') {
        const note = (await rl.question('Note (optional): ')).trim();
        passage.review = {
          verdict: 'approved',
          reviewedAt: new Date().toISOString(),
          note,
        };
        console.log(`Approved: ${writePassage(passage)}`);
      } else if (choice === 'd') {
        const sure = await rl.question(`Delete ${passage._id}? [y/N] `);
        if (sure.trim().toLowerCase() === 'y') {
          console.log(`Deleted ${deletePassage(passage)}`);
        }
      }
    }
  } finally {
    rl.close();
  }
} else {
  console.error(
    'Usage: cli.ts generate --level N [...] | check | translate | review | coverage [--level N]',
  );
  process.exit(1);
}
