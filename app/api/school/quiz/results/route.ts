/**
 * GET /api/school/quiz/results — the caller's own quiz results.
 *
 * Default is the latest attempt per course scene, including after the course
 * is unpublished. `?history=1` adds every stored attempt, newest first.
 * `ownerId` of someone else is 403. Students cannot use this to read a class.
 */
import type { NextRequest } from 'next/server';

import { getQuizResults } from '@/lib/server/school/quiz-handlers';

export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return getQuizResults(req);
}
