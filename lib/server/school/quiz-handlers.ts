/**
 * Route handlers for school quiz submit, own results, and the class gradebook.
 * Tests call these without the Next bundler. Each `route.ts` re-exports one.
 *
 * There is no update route. A retake is another POST. Scores are produced by
 * the graders, not by fields on the request body.
 */
import type { NextRequest } from 'next/server';

import { getCourseCatalog } from './course-catalog';
import { SchoolError } from './errors';
import { readJsonBody, schoolJson, withSchool } from './http';
import { classGradebook, getOwnAttempt, listOwnResults, submitQuiz } from './quiz';
import type { ShortAnswerGrader } from './quiz';
import { getQuizBank } from './quiz-bank';

let graderOverride: ShortAnswerGrader | undefined;

/** Tests stub the LLM branch. Unset uses `POST /api/quiz-grade`'s grader. */
export function setShortAnswerGraderForTests(grader: ShortAnswerGrader | undefined): void {
  graderOverride = grader;
}

async function shortAnswerGrader(req: NextRequest): Promise<ShortAnswerGrader> {
  if (graderOverride) return graderOverride;
  const { gradeShortAnswerFromRequest } = await import('@/lib/server/quiz-grade');
  return (input) => gradeShortAnswerFromRequest(req, input);
}

export function postQuizSubmit(
  req: NextRequest,
  stageId: string,
  sceneId: string,
): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const attempt = await submitQuiz({
      repo: ctx.repo,
      catalog: await getCourseCatalog(),
      bank: await getQuizBank(),
      principal: ctx.principal,
      stageId,
      sceneId,
      body: await readJsonBody(req),
      gradeShortAnswer: await shortAnswerGrader(req),
    });
    return schoolJson({ attempt }, 200, ctx.headers);
  });
}

export function getQuizResults(req: NextRequest): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const url = new URL(req.url);
    const history = url.searchParams.get('history');
    const listed = await listOwnResults({
      repo: ctx.repo,
      principal: ctx.principal,
      stageId: url.searchParams.get('stageId'),
      sceneId: url.searchParams.get('sceneId'),
      ownerId: url.searchParams.get('ownerId'),
      history: history === '1' || history === 'true',
    });
    return schoolJson(listed, 200, ctx.headers);
  });
}

export function getQuizAttempt(req: NextRequest, attemptId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const attempt = await getOwnAttempt(ctx.repo, ctx.principal, attemptId);
    return schoolJson({ attempt }, 200, ctx.headers);
  });
}

export function getClassGradebook(req: NextRequest, stageId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const url = new URL(req.url);
    const classId = url.searchParams.get('classId');
    if (!classId) throw new SchoolError(400, 'INVALID_CLASS_ID', 'classId is required');
    const gradebook = await classGradebook({
      repo: ctx.repo,
      catalog: await getCourseCatalog(),
      bank: await getQuizBank(),
      principal: ctx.principal,
      stageId,
      classId,
      sceneId: url.searchParams.get('sceneId'),
    });
    return schoolJson({ gradebook }, 200, ctx.headers);
  });
}
