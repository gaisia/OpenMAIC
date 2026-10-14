/**
 * GET /api/school/courses/:stageId/gradebook?classId= — class gradebook.
 *
 * The teacher of that class, or an admin. Students receive 403. Rows are the
 * current class-assignment members union the directly assigned students who
 * are in the class. Latest student attempt only; teacher self-tests are
 * excluded. `sceneId` limits the payload to one quiz.
 */
import type { NextRequest } from 'next/server';

import { getClassGradebook } from '@/lib/server/school/quiz-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId } = await params;
  return getClassGradebook(req, stageId);
}
