/**
 * GET /api/school/users — admin list of profiles and global roles.
 *
 * School identity must be configured (`SCHOOL_JWT_*` and `DATABASE_URL`),
 * otherwise this is 404. See `lib/server/school/README.md`.
 */
import type { NextRequest } from 'next/server';

import { getUsers } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return getUsers(req);
}
