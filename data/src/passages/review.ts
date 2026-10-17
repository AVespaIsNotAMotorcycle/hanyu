// Spot-checking passages by hand: how a passage is shown in the terminal.

import { CLOZE_BLANK, paragraphs, type Passage } from '@hanyu/shared';

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

/** Everything a reviewer needs to judge a passage, as plain text. */
export function formatForReview(passage: Passage): string {
  const { verification: v, answerKeyCheck: check } = passage;
  const lines = [
    `${passage._id} · HSK ${passage.level} · ${passage.title} (${passage.titleEnglish})`,
    '',
    ...paragraphs(passage.text).flatMap((p) => [p, '']),
  ];
  if (passage.names.length) lines.push(`Names: ${passage.names.join('、')}`);
  lines.push(
    `Level check: ${percent(v.share)} of ${v.tokens} tokens at or below the level${v.offLevel.length ? `; off level: ${v.offLevel.join('、')}` : ''}`,
    'Grammar:',
    ...passage.grammar.map((g) => `  ${g.grammarId}: ${g.example}`),
    '',
  );
  passage.questions.forEach((q, i) => {
    const answer = check?.answers.find((a) => a.questionId === q.id);
    const checker = answer
      ? `   Checker: ${answer.given} ${answer.agrees ? '✓' : '✗'}${answer.alternatives.length ? ` (also: ${answer.alternatives.join('、')})` : ''}`
      : null;
    if (q.type === 'choice') {
      lines.push(
        `${i + 1}. ${q.prompt}  (${q.promptEnglish})`,
        ...q.options.map(
          (o, j) => `   ${j === q.answer ? '→' : ' '} ${'ABCD'[j]}. ${o}`,
        ),
        `   ${q.explanation}`,
      );
    } else {
      lines.push(
        `${i + 1}. ${q.sentence.replace(CLOZE_BLANK, `［${q.answer}］`)}  (hint: ${q.hint})`,
      );
      if (q.alsoAccepted.length) {
        lines.push(`   Also accepted: ${q.alsoAccepted.join('、')}`);
      }
    }
    if (checker) lines.push(checker);
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
