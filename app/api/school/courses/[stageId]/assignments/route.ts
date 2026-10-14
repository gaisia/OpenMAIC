/**
 * GET /api/school/courses/:stageId/assignments — classes and named students.
 *
 * The course owner, or an admin inspecting. Students receive 403. Assignments
 * are returned whether or not the course is published.
 */
import type { NextRequest } from 'next/server';

import { getCourseAssignments } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId } = await params;
  return getCourseAssignments(req, stageId);
}
