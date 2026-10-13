/**
 * HTTP entry for the school directory. The admin UI is out of scope for M1;
 * these handlers are the API it will call.
 *
 * Role changes apply on the next request. Unauthenticated calls are 401
 * (`anonymousFallback: false` on the gateway method). Students and teachers
 * who call an admin action are 403.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import type { OwnerPrincipal } from '@/lib/server/identity';

import { SchoolError } from './errors';
import { schoolJwtEnvIsSet } from './jwt-config';
import { getSchoolRepository } from './repository';
import type { SchoolRepository } from './types';

export interface SchoolContext {
  principal: OwnerPrincipal;
  repo: SchoolRepository;
  headers: Headers;
}

export function schoolJson(body: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new SchoolError(400, 'INVALID_BODY', 'request body must be JSON');
  }
}

export function schoolDisabled(): boolean {
  return !isServerPersistenceConfigured() || !schoolJwtEnvIsSet();
}

export async function withSchool(
  req: NextRequest,
  handler: (ctx: SchoolContext) => Promise<Response>,
): Promise<Response> {
  if (schoolDisabled()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async (principal, headers) => {
    try {
      const repo = await getSchoolRepository();
      return await handler({ principal, repo, headers });
    } catch (error) {
      if (error instanceof SchoolError) {
        return schoolJson(
          { error: { code: error.code, message: error.message } },
          error.status,
          headers,
        );
      }
      throw error;
    }
  });
}
