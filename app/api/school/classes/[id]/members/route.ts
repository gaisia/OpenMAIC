/**
 * GET  /api/school/classes/:id/members — admin, or a teacher of the class.
 * POST /api/school/classes/:id/members — that teacher (or an admin) adds a student.
 * Body: `{ "ownerId": "user:…" }`. The user must already hold the student role.
 */
import type { NextRequest } from 'next/server';

import { getMembers, postMember } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;
  return getMembers(req, id);
}

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;
  return postMember(req, id);
}
