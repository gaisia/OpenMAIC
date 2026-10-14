/**
 * POST /api/school/courses/:stageId/publish — publish a course the caller owns.
 *
 * Requires the teacher (or admin) role and upstream `course:publish`. Writes
 * `stage_meta.is_public` / `published_at`, the same columns as
 * `POST /api/stages/:id/publish`. Publishing does not by itself let a student
 * read; the course still needs an assignment. Repeating a publish is a no-op.
 * Students receive 403.
 */
import type { NextRequest } from 'next/server';

import { postPublish } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { stageId } = await params;
  return postPublish(req, stageId);
}
