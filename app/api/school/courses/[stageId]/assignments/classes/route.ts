/**
 * POST /api/school/courses/:stageId/assignments/classes — assign a whole class.
 *
 * Body: `{ "classId" }`. The caller must own the course and teach the class.
 * Allowed on a draft: the rows are stored and students still cannot read
 * until publish. Membership is evaluated later, so a student who joins the
 * class afterwards receives the course without another assignment.
 */
import type { NextRequest } from 'next/server';

import { postClassAssignment } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId } = await params;
  return postClassAssignment(req, stageId);
}
