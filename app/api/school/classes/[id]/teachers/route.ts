/**
 * GET  /api/school/classes/:id/teachers — admin, or a teacher of the class.
 * POST /api/school/classes/:id/teachers — admin assigns a teaching teacher.
 * Body: `{ "ownerId": "user:…" }`. The user must already hold the teacher role.
 */
import type { NextRequest } from 'next/server';

import { getTeachers, postTeacher } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;
  return getTeachers(req, id);
}

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;
  return postTeacher(req, id);
}
