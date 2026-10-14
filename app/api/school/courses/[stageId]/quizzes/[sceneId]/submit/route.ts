/**
 * POST /api/school/courses/:stageId/quizzes/:sceneId/submit
 *
 * Persist one quiz attempt for the signed-in learner. Students need `canRead`
 * (published and assigned). The course owner may self-test; that row is
 * `teacher_self` and is omitted from the class gradebook. Choice questions
 * are graded locally. Short answers use the same scorer as `POST /api/quiz-grade`.
 * Each call inserts a new attempt. There is no score-edit method.
 */
import type { NextRequest } from 'next/server';

import { postQuizSubmit } from '@/lib/server/school/quiz-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string; sceneId: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId, sceneId } = await params;
  return postQuizSubmit(req, stageId, sceneId);
}
