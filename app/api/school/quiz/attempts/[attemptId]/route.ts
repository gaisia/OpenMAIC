/**
 * GET /api/school/quiz/attempts/:attemptId — one stored attempt.
 *
 * The learner who submitted it can read it after unpublish. Another student
 * receives 403. An admin may read it for inspection. There is no PATCH.
 */
import type { NextRequest } from 'next/server';

import { getQuizAttempt } from '@/lib/server/school/quiz-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ attemptId: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { attemptId } = await params;
  return getQuizAttempt(req, attemptId);
}
