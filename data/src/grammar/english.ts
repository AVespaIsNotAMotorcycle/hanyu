// English titles and explanations for the syllabus's grammar points, which
// are Chinese only. Written offline by `npm run grammar:translate` into
// data/grammar-english.json and merged into data/seed by `npm run data:build`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GrammarPoint } from '@hanyu/shared';
import { closeObjects, costOf, MODEL, type Llm } from '../passages/llm.js';
import type { SyllabusGrammarPoint } from '../parse/grammar.js';
import { dataDir } from '../paths.js';

/** Bump when the prompt or schema changes, then rerun with --force. */
export const GRAMMAR_PROMPT_VERSION = 1;

export const englishPath = path.join(dataDir, 'grammar-english.json');

export type GrammarEnglish = Pick<GrammarPoint, 'title' | 'explanation'>;

export interface GrammarEnglishFile {
  model: string;
  promptVersion: number;
  /** By grammar point ID. */
  points: Record<string, GrammarEnglish>;
}

export function readEnglish(file = englishPath): GrammarEnglishFile {
  if (!existsSync(file)) {
    return { model: MODEL, promptVersion: GRAMMAR_PROMPT_VERSION, points: {} };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as GrammarEnglishFile;
}

export function writeEnglish(
  english: GrammarEnglishFile,
  file = englishPath,
): void {
  const points = Object.fromEntries(
    Object.entries(english.points).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(file, `${JSON.stringify({ ...english, points }, null, 2)}\n`);
}

/** Adds the English to every point; the build fails if any is missing. */
export function withEnglish(
  points: SyllabusGrammarPoint[],
  english: GrammarEnglishFile,
): GrammarPoint[] {
  const missing = points.filter((p) => !english.points[p._id]);
  if (missing.length) {
    throw new Error(
      `No English for ${missing.length} grammar points (${missing
        .slice(0, 5)
        .map((p) => p._id)
        .join(', ')}…). Run npm run grammar:translate, then rebuild.`,
    );
  }
  return points.map((p) => ({ ...p, ...english.points[p._id]! }));
}

const SYSTEM = `You write the grammar reference for an app that teaches adult English speakers to read Chinese. You receive grammar points from the official HSK syllabus, whose terms and notes are in Chinese, and you explain each one in English for a beginner who cannot read those terms.

For each point, write:

- title: a short, plain English name, such as "Degree adverbs", "Yes/no questions with 吗", or "The 把 construction". Use hanzi only for the word the point is about.
- explanation: one to three sentences of plain English saying what the point means and how to recognize it in a sentence.

Rules for the explanation:

- It is for someone reading a passage who wants to understand a sentence. Prefer plain words; if you need a grammar term, say what it means.
- Give any sentence pattern with English slot names around the Chinese words that are fixed: "Subject + 把 + object + verb + 在/到 + place".
- Follow each Chinese word or form the first time it appears with its pinyin and meaning: 很 (hěn, very). Cover every word or form the point lists. Use tone marks.
- Everything else is in English. Never leave a Chinese grammar term untranslated.
- Don't add example sentences; the app shows examples from the passage.
- The syllabus numbers some entries to tell senses apart (因为1, "把"字句2, a leading （3）). Those numbers mean nothing to a learner: leave them out, and explain the sense the entry's context points to.
- 一, 不 and neutral tones: use the word's usual pronunciation in that use.

Reply with one JSON object in the required format, with one entry for every ID you receive.`;

const SCHEMA = closeObjects({
  type: 'object',
  required: ['points'],
  properties: {
    points: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'explanation'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          explanation: { type: 'string' },
        },
      },
    },
  },
});

const HAN = /\p{Script=Han}/gu;

/**
 * The forms in a plain list like 非常、很、太, or none for anything else.
 * Longer items are descriptions (名词、代词或名词性短语作主语), not forms to learn.
 */
function listedForms(content: string): string[] {
  const forms = content.split('、').map((f) => f.replace(/\d+$/, ''));
  return forms.length > 1 &&
    forms.every((f) => /^\p{Script=Han}{1,3}$/u.test(f))
    ? forms
    : [];
}

/** What's wrong with a point's English, or null if it's usable. */
export function englishProblem(
  point: SyllabusGrammarPoint,
  { title, explanation }: GrammarEnglish,
): string | null {
  if (!title || !explanation) return 'empty title or explanation';
  const latin = (s: string) => (s.match(/[a-z]/gi) ?? []).length;
  const han = (s: string) => (s.match(HAN) ?? []).length;
  if (latin(title) < 3 || latin(explanation) < han(explanation)) {
    return 'not mostly English';
  }
  const absent = listedForms(point.content).filter(
    (form) => !explanation.includes(form),
  );
  return absent.length ? `doesn't cover ${absent.join('、')}` : null;
}

export interface TranslateBatchResult {
  english: Record<string, GrammarEnglish>;
  /** The points that didn't get usable English, with why. */
  problems: { id: string; problem: string }[];
  costUsd: number;
}

/** Translates a batch; points that fail are reported, for a rerun to retry. */
export async function translateGrammar(
  points: SyllabusGrammarPoint[],
  llm: Llm,
): Promise<TranslateBatchResult> {
  const response = await llm.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: JSON.stringify(
          points.map((p) => ({
            id: p._id,
            hskLevel: p.level === 7 ? '7-9' : p.level,
            category: p.category,
            name: p.name,
            item: p.item,
            content: p.content,
          })),
          null,
          1,
        ),
      },
    ],
  });
  const costUsd = costOf(response.usage);
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let reply: { points?: ({ id: string } & GrammarEnglish)[] };
  try {
    reply = JSON.parse(text) as typeof reply;
  } catch {
    return {
      english: {},
      problems: points.map((p) => ({
        id: p._id,
        problem: `The reply was not complete JSON (stop reason: ${response.stop_reason ?? 'unknown'})`,
      })),
      costUsd,
    };
  }
  const byId = new Map((reply.points ?? []).map((p) => [p.id, p]));
  const english: Record<string, GrammarEnglish> = {};
  const problems: TranslateBatchResult['problems'] = [];
  for (const point of points) {
    const entry = byId.get(point._id);
    const candidate = {
      title: entry?.title.trim() ?? '',
      explanation: entry?.explanation.trim() ?? '',
    };
    const problem = entry
      ? englishProblem(point, candidate)
      : 'not in the reply';
    if (problem) problems.push({ id: point._id, problem });
    else english[point._id] = candidate;
  }
  return { english, problems, costUsd };
}
