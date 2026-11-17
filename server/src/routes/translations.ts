import { Router } from 'express';
import {
  MAX_TRANSLATION_LENGTH,
  paragraphs,
  type Passage,
  type TranslationGradingsResponse,
} from '@hanyu/shared';
import { createGrader, gradingsFor, type GradingOptions } from '../grading.js';
import { PassageModel } from '../models/index.js';

export type { GradingOptions } from '../grading.js';

export function badRequest(error: string) {
  return Object.assign(new Error(error), { status: 400, expose: true });
}

/** Checks a learner's translation from a request body. */
export function translationText(translation: unknown): string {
  if (
    typeof translation !== 'string' ||
    !translation.trim() ||
    translation.length > MAX_TRANSLATION_LENGTH
  ) {
    throw badRequest(
      `translation must be 1 to ${MAX_TRANSLATION_LENGTH} characters`,
    );
  }
  return translation;
}

/**
 * Chinese → English translation exercises (a passage's paragraphs), graded
 * by an LLM at request time. Every grading is logged.
 */
export function createTranslationsRouter(options: GradingOptions) {
  const router = Router();
  const grader = createGrader(options);

  router.get('/', async (req, res) => {
    const passageId = req.query.passageId;
    if (typeof passageId !== 'string' || !passageId) {
      throw badRequest('passageId is required');
    }
    const user = req.user!;
    const body: TranslationGradingsResponse = {
      gradings: await gradingsFor(user._id, passageId),
      limits: await grader.limits(user),
    };
    res.json(body);
  });

  // Body: GradeTranslationRequest.
  router.post('/', async (req, res) => {
    const { passageId, paragraph, translation } = req.body ?? {};
    if (typeof passageId !== 'string' || !passageId) {
      throw badRequest('passageId is required');
    }
    if (!Number.isInteger(paragraph) || paragraph < 0) {
      throw badRequest('paragraph must be a paragraph index');
    }
    const text = translationText(translation);
    const passage = await PassageModel.findById(passageId, {
      text: 1,
      tokens: 1,
      translation: 1,
    }).lean<Pick<Passage, 'text' | 'tokens' | 'translation'>>();
    if (!passage) {
      res.status(404).json({ error: 'No such passage' });
      return;
    }
    const source = paragraphs(passage.text)[paragraph];
    const reference = passage.translation?.[paragraph];
    if (!source || !reference) {
      throw badRequest('That paragraph has no translation exercise');
    }
    await grader.grade(res, {
      user: req.user!,
      passageId,
      paragraph,
      direction: 'zh-en',
      source,
      reference,
      tokens: passage.tokens?.[paragraph] ?? [],
      translation: text,
    });
  });

  return router;
}
