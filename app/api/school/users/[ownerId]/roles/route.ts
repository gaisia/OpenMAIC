/**
 * PUT /api/school/users/:ownerId/roles — admin replaces global roles.
 * Body: `{ "roles": ["teacher"] }`. Takes effect on the user's next request.
 */
import type { NextRequest } from 'next/server';

import { putUserRoles } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ ownerId: string }> };

export async function PUT(req: NextRequest, { params }: Params): Promise<Response> {
  const { ownerId } = await params;
  return putUserRoles(req, ownerId);
}
