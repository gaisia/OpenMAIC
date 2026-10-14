/**
 * POST /api/school/courses/:stageId/unpublish — clear publication.
 *
 * Same role gate as publish. Assignments are kept, so a later publish
 * restores student access without assigning again. Until then, every student
 * loses the course, including a direct stage-id read.
 */
import type { NextRequest } from 'next/server';

import { postUnpublish } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId } = await params;
  return postUnpublish(req, stageId);
}
