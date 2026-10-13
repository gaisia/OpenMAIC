/**
 * GET  /api/school/classes — admins see every class; teachers see classes they teach.
 * POST /api/school/classes — admin creates a class. Body: `{ "name": "Class-1" }`.
 */
import type { NextRequest } from 'next/server';

import { getClasses, postClass } from '@/lib/server/school/handlers';

export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return getClasses(req);
}

export function POST(req: NextRequest): Promise<Response> {
  return postClass(req);
}
