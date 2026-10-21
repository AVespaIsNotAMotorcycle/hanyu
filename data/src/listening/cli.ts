// Listening exercise generation, checking, review, and coverage CLI.
//
//   npm run listening:generate -- --level 1 [--count 5] [--max-cost 2]
//                                 [--grammar g1-008] [--dry-run]
//   npm run listening:check [-- --level 1] [--force] [--max-cost 1]
//   npm run listening:review [-- --level 1] [--sample 3]
//   npm run listening:coverage [-- --level 1]
//
// Generation and checking need ANTHROPIC_API_KEY (in .env). Exercises are
// written to data/listening/hsk<level>/ for review. Record them with
// `npm run audio:generate`, then load them with `npm run db:seed`.

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { HSK_LEVELS, isHskLevel, type HskLevel } from '@hanyu/shared';
import { createSegmenter } from '../segmenter.js';
import { checkAnswerKey, needsCheck } from '../passages/answerKey.js';
import { loadSeedContent } from '../passages/content.js';
import {
  grammarCoverage,
  libraryStatus,
  nextPassageId,
  pickSample,
} from '../passages/library.js';
import { MODEL, type Llm } from '../passages/llm.js';
import {
  asPassage,
  generateExercise,
  systemPrompt,
  userPrompt,
} from './generate.js';
import { deleteExercise, readExercises, writeExercise } from './library.js';
import { formatForReview } from './review.js';

/** Topics of the level's latest exercises sent to steer away from. */
const RECENT_TOPICS = 40;

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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function levelArg(required: boolean): HskLevel | undefined {
  if (values.level === undefined && !required) return undefined;
  const level = Number(values.level);
  if (!isHskLevel(level)) fail('--level must be 1 to 7 (7 = levels 7–9)');
  return level;
}

function costCap(fallback: number): number {
  const cap = Number(values['max-cost'] ?? fallback);
  if (!(cap > 0)) fail('--max-cost must be above 0');
  return cap;
}

function anthropic(): Llm {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail('Set ANTHROPIC_API_KEY (in .env) to call the API.');
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
    const exercises = readExercises(level);
    const coverage = grammarCoverage(content.grammar, exercises, level);
    const covered = coverage.filter((c) => c.passages > 0).length;
    const status = libraryStatus(exercises);
    console.log(
      `HSK ${level}: ${exercises.length} exercises (${status.checked} passed the answer-key check${status.failed ? `, ${status.failed} failed` : ''}, ${status.reviewed} reviewed by hand), ${covered}/${coverage.length} grammar points covered`,
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
  const cap = costCap(2);
  if (!(count >= 1)) fail('--count must be at least 1');
  const chosen = values.grammar?.split(',').map((id) => id.trim());
  for (const id of chosen ?? []) {
    if (!content.grammar.some((g) => g._id === id && g.level === level)) {
      fail(`${id} is not a level-${level} grammar point`);
    }
  }

  const exercises = readExercises(level);
  // One grammar point each: the least covered, unless --grammar picks.
  const pickTargets = () =>
    chosen
      ? content.grammar.filter((g) => chosen.includes(g._id))
      : grammarCoverage(content.grammar, exercises, level)
          .slice(0, 1)
          .map((c) => c.point);
  const usedTopics = () => exercises.slice(-RECENT_TOPICS).map((e) => e.topic);

  if (values['dry-run']) {
    console.log(systemPrompt(level, content)[0]!.text);
    console.log('\n---\n');
    console.log(userPrompt(level, pickTargets(), usedTopics()));
    process.exit(0);
  }
  const llm = anthropic();
  const segmenter = createSegmenter(content.wordLevels.keys());
  let spent = 0;
  let written = 0;
  for (let i = 0; i < count; i++) {
    const targets = pickTargets();
    const id = nextPassageId(exercises, level, 'l');
    console.log(
      `${id}: ${targets.map((t) => `${t._id} ${t.name}${t.item ? `/${t.item}` : ''}`).join(', ')}`,
    );
    const result = await generateExercise({
      id,
      level,
      targets,
      usedTopics: usedTopics(),
      content,
      segmenter,
      llm,
      budgetUsd: cap - spent,
    });
    spent += result.costUsd;
    if (result.exercise) {
      exercises.push(result.exercise);
      written++;
      const v = result.exercise.verification;
      console.log(
        `  ✓ ${writeExercise(result.exercise)} (${(v.share * 100).toFixed(1)}% at level, ${result.attempts} attempt(s), $${result.costUsd.toFixed(3)})`,
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
    `${written} exercise(s) written with ${MODEL}; spent about $${spent.toFixed(3)} of $${cap}.`,
  );
  if (written) console.log('Record them with npm run audio:generate.');
} else if (command === 'check') {
  // Runs the answer-key check where it's missing or out of date (--force
  // reruns it everywhere).
  const cap = costCap(1);
  let llm: Llm | null = null;
  let spent = 0;
  let lastCost = 0;
  const failed: string[] = [];
  run: for (const level of levelsArg()) {
    for (const exercise of readExercises(level)) {
      if (needsCheck(exercise) || values.force) {
        if (spent + (lastCost || 0.01) > cap) {
          console.log(`Stopped: the next check could pass the $${cap} cap.`);
          break run;
        }
        llm ??= anthropic();
        const result = await checkAnswerKey(asPassage(exercise), { llm });
        lastCost = result.costUsd;
        spent += result.costUsd;
        exercise.answerKeyCheck = result.check;
        writeExercise(exercise);
        console.log(
          `${exercise._id}: ${result.check.passed ? '✓ passed' : '✗ failed'} ($${result.costUsd.toFixed(3)})`,
        );
        for (const p of result.problems) console.log(`  - ${p}`);
      }
      if (exercise.answerKeyCheck?.passed === false) failed.push(exercise._id);
    }
  }
  console.log(`Spent about $${spent.toFixed(3)} of $${cap}.`);
  if (failed.length) {
    console.log(
      `Failed the answer-key check (db:seed refuses them; regenerate or delete): ${failed.join(', ')}`,
    );
  }
} else if (command === 'review') {
  // Spot-check a random sample of exercises that passed the automated checks.
  const sample = Number(values.sample);
  if (!(sample >= 1)) fail('--sample must be at least 1');
  const chosen = pickSample(
    levelsArg().flatMap((l) => readExercises(l)),
    sample,
  );
  if (!chosen.length) {
    console.log(
      'Nothing to review: every exercise that passed the answer-key check has been reviewed.',
    );
    process.exit(0);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, exercise] of chosen.entries()) {
      console.log(`\n──── ${i + 1} of ${chosen.length} ────\n`);
      console.log(formatForReview(exercise));
      const choice = (
        await rl.question('\n[a]pprove, [d]elete, [s]kip, or [q]uit? ')
      )
        .trim()
        .toLowerCase();
      if (choice === 'q') break;
      if (choice === 'a') {
        const note = (await rl.question('Note (optional): ')).trim();
        exercise.review = {
          verdict: 'approved',
          reviewedAt: new Date().toISOString(),
          note,
        };
        console.log(`Approved: ${writeExercise(exercise)}`);
      } else if (choice === 'd') {
        const sure = await rl.question(`Delete ${exercise._id}? [y/N] `);
        if (sure.trim().toLowerCase() === 'y') {
          console.log(`Deleted ${deleteExercise(exercise)}`);
        }
      }
    }
  } finally {
    rl.close();
  }
} else {
  fail(
    'Usage: cli.ts generate --level N [...] | check | review | coverage [--level N]',
  );
}
