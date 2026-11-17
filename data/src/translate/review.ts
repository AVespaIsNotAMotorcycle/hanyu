// Spot-checking Translate exercises by hand: how one is shown in the terminal.

import type { TranslateExercise } from '@hanyu/shared';

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

/** Everything a reviewer needs to judge an exercise, as plain text. */
export function formatForReview(exercise: TranslateExercise): string {
  const { verification: v, answerKeyCheck: check } = exercise;
  return [
    `${exercise._id} · HSK ${exercise.level} · ${exercise.topic}`,
    '',
    exercise.english,
    `  → ${exercise.reference}`,
    '',
    `Level check: ${percent(v.share)} of ${v.tokens} tokens at or below the level${v.offLevel.length ? `; off level: ${v.offLevel.join('、')}` : ''}`,
    'Grammar:',
    ...exercise.grammar.map((g) => `  ${g.grammarId}: ${g.example}`),
    '',
    check
      ? `Reference check (${check.model}, ${check.checkedAt.slice(0, 10)}): ${check.passed ? 'passed' : 'FAILED'}`
      : 'Reference check: not run',
    ...(check?.issues ?? []).map((i) => `  [${i.severity}] ${i.description}`),
  ].join('\n');
}
