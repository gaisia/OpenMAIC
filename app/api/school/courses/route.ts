/**
 * GET /api/school/courses — the signed-in student's courses.
 *
 * Only courses that satisfy canRead: published, and assigned to one of the
 * student's current classes or to the student directly. Drafts and
 * preconfigured assignments are omitted. Teachers use GET /api/stages for
 * the courses they own.
 */
import type { NextRequest } from 'next/server';

import { getMyCourses } from '@/lib/server/school/course-handlers';

export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return getMyCourses(req);
}
