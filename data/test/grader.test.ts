import { existsSync } from 'node:fs';
import {
  GRADER_MODEL,
  GRADER_PROMPT_VERSION,
  parseGraderReply,
  type GradingResult,
} from '@hanyu/shared';
import { describe, expect, it } from 'vitest';
import { replyProblems, type LearnerItem } from '../src/grader/learnerSet.js';
import {
  calibrationMetrics,
  calibrationOutcome,
  learnerMetrics,
  learnerOutcome,
  spearman,
} from '../src/grader/metrics.js';
import { calibrationSample, mqmItems, parseMqm } from '../src/grader/mqm.js';
import { readLearnerSet, resultsFile } from '../src/grader/results.js';

describe('grader evals', () => {
  it('have results for the current grader model and prompt version', () => {
    // Changed the grading prompt or model? Run `npm run grader:eval`.
    expect(existsSync(resultsFile(GRADER_MODEL, GRADER_PROMPT_VERSION))).toBe(
      true,
    );
  });

  it('have a learner set whose answer keys quote their texts', () => {
    const items = readLearnerSet();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      for (const error of item.injected) {
        expect(item.source, item.id).toContain(error.sourceSpan);
      }
      if (item.kind === 'paraphrase') expect(item.injected).toEqual([]);
    }
  });
});

const TSV = [
  'system\tdoc\tdoc_id\tseg_id\trater\tsource\ttarget\tcategory\tseverity',
  'ref\tt\t1\t1\tr1\t我买了书。\tI bought a book.\tNo-error\tno-error',
  'sysA\tt\t1\t1\tr1\t我买了书。\tI <v>buy</v> a book.\tAccuracy/Mistranslation\tMajor',
  'sysA\tt\t1\t1\tr1\t我买了书。\tI buy a book<v>.</v>\tFluency/Punctuation\tMinor',
  'sysA\tt\t1\t1\tr1\t我<v>买了</v>书。\tI buy a book.\tAccuracy/Omission\tMinor',
  'sysB\tt\t1\t1\tr2\t我买了书。\tI bought a book.\tNo-error\tno-error',
  'refB\tt\t1\t1\tr2\t我买了书。\tI purchased a book.\tNo-error\tno-error',
].join('\n');

describe('MQM calibration items', () => {
  const items = mqmItems(parseMqm(TSV));

  it('builds items with penalties and untagged spans, skipping references', () => {
    expect(items.map((i) => [i.id, i.penalty])).toEqual([
      ['sysA/1', 6.1],
      ['sysB/1', 0],
    ]);
    const a = items[0]!;
    expect(a.translation).toBe('I buy a book.');
    expect(a.reference).toBe('I bought a book.');
    expect(a.errors[0]).toMatchObject({ targetStart: 2, targetEnd: 5 });
    expect(a.errors[2]).toMatchObject({ sourceStart: 1, sourceEnd: 3 });
  });

  it('samples deterministically within penalty bands', () => {
    // The fixture's source is too short for the learner-length filter.
    expect(calibrationSample(items)).toEqual([]);
    const long = items.map((i) => ({ ...i, source: i.source.repeat(4) }));
    expect(calibrationSample(long, 1).map((i) => i.id)).toEqual(['sysB/1']);
  });
});

const result = (
  errors: {
    translationSpan: string;
    sourceSpan: string;
    severity: 'major' | 'minor';
  }[],
  input: { source: string; translation: string },
  score = 3,
): GradingResult =>
  parseGraderReply(
    {
      scores: {
        accuracy: { score, comment: '' },
        completeness: { score, comment: '' },
        grammar: { score, comment: '' },
        naturalness: { score, comment: '' },
      },
      errors: errors.map((e) => ({
        ...e,
        criterion: 'accuracy',
        explanation: '',
        suggestion: '',
      })),
      mistranslatedWords: [],
      summary: '',
    },
    { ...input, reference: '' },
  );

describe('metrics', () => {
  it('computes Spearman correlation with ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2], [1, 2, 3])).toBeCloseTo(0.866, 2);
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it('scores calibration items by span overlap', () => {
    const [a, b] = mqmItems(parseMqm(TSV));
    const outcomeA = calibrationOutcome(
      a!,
      result(
        [{ translationSpan: 'buy', sourceSpan: '', severity: 'major' }],
        a!,
      ),
    );
    expect(outcomeA).toMatchObject({
      mqmPenalty: 6.1,
      graderPenalty: 5,
      majorSpans: 1,
      majorFound: 1,
    });
    const outcomeB = calibrationOutcome(b!, result([], b!, 5));
    expect(calibrationMetrics([outcomeA, outcomeB])).toMatchObject({
      items: 2,
      majorSpanRecall: 1,
      cleanWithoutMajor: 1,
    });
  });

  it('finds injected errors by translation or source span', () => {
    const item: LearnerItem = {
      id: 'p1-0001/0/injected',
      passageId: 'p1-0001',
      paragraph: 0,
      source: '我昨天买了两本书，也买了水果。',
      reference: 'Yesterday I bought two books and also some fruit.',
      translation: 'Yesterday I buy two books.',
      kind: 'injected',
      injected: [
        {
          type: 'tense',
          translationSpan: 'buy',
          sourceSpan: '买了',
          description: '',
        },
        {
          type: 'dropped',
          translationSpan: '',
          sourceSpan: '也买了水果',
          description: '',
        },
      ],
    };
    const both = learnerOutcome(
      item,
      result(
        [
          { translationSpan: 'buy', sourceSpan: '', severity: 'major' },
          { translationSpan: '', sourceSpan: '水果', severity: 'major' },
        ],
        item,
      ),
    );
    expect(both).toMatchObject({
      injected: 2,
      injectedFound: 2,
      graderMajors: 2,
    });
    const one = learnerOutcome(
      item,
      result(
        [{ translationSpan: 'two', sourceSpan: '买了', severity: 'minor' }],
        item,
      ),
    );
    expect(one.injectedFound).toBe(1);
    const paraphrase = learnerOutcome(
      { ...item, kind: 'paraphrase', injected: [] },
      result([], item, 5),
    );
    expect(learnerMetrics([both, one, paraphrase])).toMatchObject({
      injectedRecall: 0.75,
      paraphraseWithoutMajor: 1,
      meanOverallParaphrase: 5,
    });
  });
});

describe('learner-set replies', () => {
  const context = {
    source: '我买了书。',
    reference: 'I bought a book.',
    count: 1,
  };
  it('requires changed text, exact quotes, and the requested error count', () => {
    expect(
      replyProblems(
        {
          injected: 'I buy a book.',
          errors: [
            {
              type: 't',
              translationSpan: 'buy',
              sourceSpan: '买了',
              description: '',
            },
          ],
          paraphrase: 'I purchased a book.',
        },
        context,
      ),
    ).toEqual([]);
    expect(
      replyProblems(
        {
          injected: 'I bought a book.',
          errors: [
            {
              type: 't',
              translationSpan: 'sell',
              sourceSpan: '卖',
              description: '',
            },
            {
              type: 't',
              translationSpan: '',
              sourceSpan: '书',
              description: '',
            },
          ],
          paraphrase: '',
        },
        context,
      ),
    ).toHaveLength(5);
  });
});
