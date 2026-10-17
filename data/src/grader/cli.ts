// Translation grader evals (offline; ANTHROPIC_API_KEY in .env).
//
//   npm run grader:learner-set [-- --force] [--max-cost 1]
//       build data/grader-evals/learner.json from passages with reference translations
//   npm run grader:eval [-- --max-cost 2]
//       grade the calibration and learner sets; write results for this grader version
//   npm run grader:consistency [-- --max-cost 0.5]
//       re-grade a fixed sample and compare with the eval run
//
// Run grader:eval whenever GRADER_MODEL or GRADER_PROMPT_VERSION changes
// (data/test/grader.test.ts fails until results exist for the version).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import {
  gradeTranslation,
  GRADER_MODEL,
  GRADER_PROMPT_VERSION,
  GraderError,
  HSK_LEVELS,
  paragraphs,
  type JsonLlm,
} from '@hanyu/shared';
import { readPassages } from '../passages/library.js';
import type { Llm } from '../passages/llm.js';
import { rawDir } from '../paths.js';
import { sourceById } from '../sources.js';
import {
  buildParagraphItems,
  INJECTION_TYPES,
  type LearnerItem,
} from './learnerSet.js';
import {
  calibrationMetrics,
  calibrationOutcome,
  learnerMetrics,
  learnerOutcome,
  type CalibrationOutcome,
  type LearnerOutcome,
} from './metrics.js';
import {
  calibrationSample,
  mqmItems,
  parseMqm,
  type CalibrationItem,
} from './mqm.js';
import {
  readLearnerSet,
  readResults,
  writeConsistency,
  writeLearnerSet,
  writeResults,
  type ConsistencyRun,
} from './results.js';

/** Items per set the consistency check re-grades. */
const CONSISTENCY_SAMPLE = 5;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'max-cost': { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});
const command = positionals[0];

function costCap(fallback: number): number {
  const cap = Number(values['max-cost'] ?? fallback);
  if (!(cap > 0)) {
    console.error('--max-cost must be above 0');
    process.exit(1);
  }
  return cap;
}

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY (in .env) to call the API.');
    process.exit(1);
  }
  return new Anthropic();
}

function calibrationSet(): CalibrationItem[] {
  const file = path.join(rawDir, sourceById('mqm-ted-zhen').file);
  let tsv: string;
  try {
    tsv = readFileSync(file, 'utf8');
  } catch {
    console.error(`${file} is missing; run npm run data:fetch first.`);
    process.exit(1);
  }
  return calibrationSample(mqmItems(parseMqm(tsv)));
}

/** Spends against a cap, estimating each call from the last one. */
class Budget {
  spent = 0;
  private last = 0;
  constructor(readonly cap: number) {}
  canSpend() {
    return this.spent + (this.last || 0.02) <= this.cap;
  }
  add(cost: number) {
    this.last = cost;
    this.spent += cost;
  }
}

async function grade(
  llm: JsonLlm,
  budget: Budget,
  item: { id: string; source: string; reference: string; translation: string },
) {
  if (!budget.canSpend()) {
    console.log(`Stopped: the next call could pass the $${budget.cap} cap.`);
    process.exit(1);
  }
  try {
    const out = await gradeTranslation(item, llm);
    budget.add(out.costUsd);
    return out.result;
  } catch (err) {
    if (err instanceof GraderError) budget.add(err.costUsd);
    console.log(`  ${item.id}: grading failed (${String(err)}); skipped`);
    return null;
  }
}

if (command === 'learner-set') {
  const budget = new Budget(costCap(1));
  const anthropic = client();
  const llm: Llm = { create: (params) => anthropic.messages.create(params) };
  const existing = values.force ? [] : readLearnerSet();
  const done = new Set(existing.map((i) => `${i.passageId}/${i.paragraph}`));
  const items: LearnerItem[] = [...existing];
  let n = 0;
  run: for (const level of HSK_LEVELS) {
    for (const passage of readPassages(level)) {
      if (!passage.translation) continue;
      for (
        let paragraph = 0;
        paragraph < paragraphs(passage.text).length;
        paragraph++
      ) {
        // Round-robin over the error types, two per paragraph.
        const types = [INJECTION_TYPES[n % 4]!, INJECTION_TYPES[(n + 1) % 4]!];
        n++;
        if (done.has(`${passage._id}/${paragraph}`)) continue;
        if (!budget.canSpend()) {
          console.log(
            `Stopped: the next call could pass the $${budget.cap} cap.`,
          );
          break run;
        }
        const result = await buildParagraphItems(
          { passage, paragraph, types },
          llm,
        );
        budget.add(result.costUsd);
        if (result.items.length) {
          items.push(...result.items);
          console.log(`${passage._id}/${paragraph}: ✓`);
        } else {
          console.log(
            `${passage._id}/${paragraph}: ✗ ${result.problems.join(' ')}`,
          );
        }
      }
    }
  }
  console.log(
    `${writeLearnerSet(items)}: ${items.length} items; spent about $${budget.spent.toFixed(3)}.`,
  );
} else if (command === 'eval') {
  const budget = new Budget(costCap(2));
  const anthropic = client();
  const llm: JsonLlm = {
    create: (params) => anthropic.messages.create(params),
  };
  const calibration = calibrationSet();
  const learner = readLearnerSet();
  if (!learner.length) {
    console.error('No learner set yet; run npm run grader:learner-set first.');
    process.exit(1);
  }
  console.log(
    `Grading ${calibration.length} calibration and ${learner.length} learner items with ${GRADER_MODEL} (prompt v${GRADER_PROMPT_VERSION})`,
  );
  const calibrationItems: CalibrationOutcome[] = [];
  for (const item of calibration) {
    const result = await grade(llm, budget, item);
    if (result) calibrationItems.push(calibrationOutcome(item, result));
  }
  const learnerItems: LearnerOutcome[] = [];
  for (const item of learner) {
    const result = await grade(llm, budget, item);
    if (result) learnerItems.push(learnerOutcome(item, result));
  }
  const results = {
    model: GRADER_MODEL,
    promptVersion: GRADER_PROMPT_VERSION,
    ranAt: new Date().toISOString(),
    costUsd: Math.round(budget.spent * 10000) / 10000,
    calibration: calibrationMetrics(calibrationItems),
    learner: learnerMetrics(learnerItems),
    calibrationItems,
    learnerItems,
  };
  console.log('Calibration (MQM):', results.calibration);
  console.log('Learner-style:', results.learner);
  console.log(
    `${writeResults(results)}; spent about $${budget.spent.toFixed(3)}.`,
  );
} else if (command === 'consistency') {
  const budget = new Budget(costCap(0.5));
  const before = readResults(GRADER_MODEL, GRADER_PROMPT_VERSION);
  if (!before) {
    console.error(
      `No eval results for ${GRADER_MODEL} v${GRADER_PROMPT_VERSION}; run npm run grader:eval first.`,
    );
    process.exit(1);
  }
  const anthropic = client();
  const llm: JsonLlm = {
    create: (params) => anthropic.messages.create(params),
  };
  // A fixed sample: the first items (by ID) of each set that the eval graded.
  const calibration = new Map(calibrationSet().map((i) => [i.id, i]));
  const learner = new Map(readLearnerSet().map((i) => [i.id, i]));
  const sample = [
    ...before.calibrationItems
      .flatMap((o) => calibration.get(o.id) ?? [])
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, CONSISTENCY_SAMPLE),
    ...before.learnerItems
      .flatMap((o) => learner.get(o.id) ?? [])
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, CONSISTENCY_SAMPLE),
  ];
  const earlier = new Map(
    [...before.calibrationItems, ...before.learnerItems].map((o) => [o.id, o]),
  );
  const items: ConsistencyRun['items'] = [];
  for (const item of sample) {
    const result = await grade(llm, budget, item);
    if (!result) continue;
    const now =
      'kind' in item
        ? learnerOutcome(item, result)
        : calibrationOutcome(item, result);
    const then = earlier.get(item.id)!;
    items.push({
      id: item.id,
      overall: now.overall,
      before: then.overall,
      graderPenalty: now.graderPenalty,
      penaltyBefore: then.graderPenalty,
    });
    const change = now.overall - then.overall;
    console.log(
      `${item.id}: overall ${then.overall} → ${now.overall}${Math.abs(change) >= 1 ? '  ⚠ changed by a point or more' : ''}`,
    );
  }
  const run: ConsistencyRun = {
    model: GRADER_MODEL,
    promptVersion: GRADER_PROMPT_VERSION,
    ranAt: new Date().toISOString(),
    costUsd: Math.round(budget.spent * 10000) / 10000,
    meanOverallChange: items.length
      ? Math.round(
          (items.reduce((n, i) => n + Math.abs(i.overall - i.before), 0) /
            items.length) *
            1000,
        ) / 1000
      : null,
    items,
  };
  console.log(`Mean change in overall score: ${run.meanOverallChange}`);
  console.log(
    `${writeConsistency(run)}; spent about $${budget.spent.toFixed(3)}.`,
  );
} else {
  console.error('Usage: cli.ts learner-set | eval | consistency');
  process.exit(1);
}
