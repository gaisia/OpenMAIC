/**
 * POST /api/school/courses/:stageId/assignments/students — assign named students.
 *
 * Body: `{ "ownerIds": ["user:…"] }`. Each person must already be a student in
 * a class the caller teaches. The grant is the union of this list and any
 * whole-class assignment. Drafts may be preconfigured; students cannot read
 * until the course is published.
 */
import type { NextRequest } from 'next/server';

import { postStudentAssignment } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId } = await params;
  return postStudentAssignment(req, stageId);
}
