/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 * School quiz submit uses the same prompt and parser (`lib/server/quiz-grade.ts`)
 * and is what persists the score.
 */
import { modelAuthorizationResponse } from '@/lib/server/api-response';

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { interpretShortAnswerGrade, shortAnswerPrompt } from '@/lib/server/quiz-grade';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  try {
    const body = (await req.json()) as GradeRequest;
    const { question, userAnswer, points, commentPrompt, language } = body;
    questionSnippet = question?.substring(0, 60);
    resolvedPoints = points;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
    }

    // Validate points is a positive finite number
    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number');
    }

    // Resolve model from request headers/body
    const {
      model: languageModel,
      thinkingConfig,
      serverManaged,
    } = await resolveModelFromRequest(req, body, 'quiz-grade');

    const prompts = shortAnswerPrompt({ question, userAnswer, points, commentPrompt, language });

    const result = await callLLM(
      {
        model: languageModel,
        system: prompts.system,
        prompt: prompts.prompt,
      },
      'quiz-grade',
      undefined,
      thinkingConfig,
      { serverManaged },
    );

    return apiSuccess({ ...interpretShortAnswerGrade(result.text, points, language) });
  } catch (error) {
    const authorization = modelAuthorizationResponse(error);
    if (authorization) return authorization;
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer');
  }
}
