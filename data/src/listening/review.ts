// Spot-checking listening exercises by hand: how one is shown in the terminal.

import type { ListeningExercise } from '@hanyu/shared';
import { clipFile, readManifest } from '../audio/library.js';
import { audioKeys } from '@hanyu/shared';

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

/** Everything a reviewer needs to judge an exercise, as plain text. */
export function formatForReview(
  exercise: ListeningExercise,
  manifest = readManifest(),
): string {
  const { verification: v, answerKeyCheck: check } = exercise;
  const clip = manifest.clips[audioKeys.listening(exercise._id)];
  const lines = [
    `${exercise._id} · HSK ${exercise.level} · ${exercise.topic}`,
    '',
    exercise.text,
    `  → ${exercise.textEnglish}`,
    '',
    clip
      ? `Recording: ${clipFile(clip.hash)}`
      : 'Recording: none yet (npm run audio:generate)',
  ];
  if (exercise.names.length) lines.push(`Names: ${exercise.names.join('、')}`);
  lines.push(
    `Level check: ${percent(v.share)} of ${v.tokens} tokens at or below the level${v.offLevel.length ? `; off level: ${v.offLevel.join('、')}` : ''}`,
    'Grammar:',
    ...exercise.grammar.map((g) => `  ${g.grammarId}: ${g.example}`),
    '',
  );
  exercise.questions.forEach((q, i) => {
    const answer = check?.answers.find((a) => a.questionId === q.id);
    lines.push(
      `${i + 1}. ${q.prompt}  (${q.promptEnglish})`,
      ...q.options.map(
        (o, j) => `   ${j === q.answer ? '→' : ' '} ${'ABCD'[j]}. ${o}`,
      ),
      `   ${q.explanation}`,
    );
    if (answer) {
      lines.push(
        `   Checker: ${answer.given} ${answer.agrees ? '✓' : '✗'}${answer.alternatives.length ? ` (also: ${answer.alternatives.join('、')})` : ''}`,
      );
    }
  });
  lines.push(
    '',
    check
      ? `Answer-key check (${check.model}, ${check.checkedAt.slice(0, 10)}): ${check.passed ? 'passed' : 'FAILED'}`
      : 'Answer-key check: not run',
    ...(check?.issues ?? []).map((i) => `  [${i.severity}] ${i.description}`),
  );
  return lines.join('\n');
}
