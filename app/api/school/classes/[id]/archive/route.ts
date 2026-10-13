/** POST /api/school/classes/:id/archive — admin archives a class. Idempotent. */
import type { NextRequest } from 'next/server';

import { postArchive } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;
  return postArchive(req, id);
}
