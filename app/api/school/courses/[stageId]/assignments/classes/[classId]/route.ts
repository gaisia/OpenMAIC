/**
 * DELETE /api/school/courses/:stageId/assignments/classes/:classId
 *
 * Drops the class assignment. Students who only had the course through that
 * class lose it on the next read. A direct student assignment is left in place.
 */
import type { NextRequest } from 'next/server';

import { deleteClassAssignment } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string; classId: string }> };

export async function DELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId, classId } = await params;
  return deleteClassAssignment(req, stageId, classId);
}
