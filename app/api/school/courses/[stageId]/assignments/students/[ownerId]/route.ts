/**
 * DELETE /api/school/courses/:stageId/assignments/students/:ownerId
 *
 * Drops the direct assignment. The student keeps the course when they still
 * belong to a class it is assigned to.
 */
import type { NextRequest } from 'next/server';

import { deleteStudentAssignment } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string; ownerId: string }> };

export async function DELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId, ownerId } = await params;
  return deleteStudentAssignment(req, stageId, ownerId);
}
