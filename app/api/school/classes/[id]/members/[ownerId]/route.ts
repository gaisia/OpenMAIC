/** DELETE /api/school/classes/:id/members/:ownerId — teacher of the class, or an admin, removes a member. */
import type { NextRequest } from 'next/server';

import { deleteMember } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; ownerId: string }> };

export async function DELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const { id, ownerId } = await params;
  return deleteMember(req, id, ownerId);
}
