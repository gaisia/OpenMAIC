/** DELETE /api/school/classes/:id/teachers/:ownerId — admin removes a teaching teacher. */
import type { NextRequest } from 'next/server';

import { deleteTeacher } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; ownerId: string }> };

export async function DELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const { id, ownerId } = await params;
  return deleteTeacher(req, id, ownerId);
}
