/**
 * GET /api/stages/[id]/status
 *
 * Returns the public-state metadata for a stage. Used by the Share menu CTA
 * to know whether to show "Publish" or "Already published · Unpublish".
 *
 * Outside school mode, no auth is required — any caller who has the stage ID
 * can read its public flag. School mode disables that public path: the caller
 * must be signed in and allowed to read the course. A copied link does not
 * widen that.
 *
 * Convention: snake_case error codes (e.g. `not_found`, `internal_error`).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { schoolDocumentReadDenial } from '@/lib/server/school/courses';
import { schoolJwtEnvIsSet } from '@/lib/server/school/jwt-config';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  const { id } = await params;
  if (schoolJwtEnvIsSet()) return schoolStatus(req, id);
  return publicStatus(id);
}

async function schoolStatus(req: NextRequest, id: string): Promise<Response> {
  return withRequestOwner(req, async (principal, responseHeaders) => {
    try {
      const access = await resolveStageAccess(id);
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }
      const denial = await schoolDocumentReadDenial(principal, id);
      if (denial) {
        for (const [name, value] of responseHeaders.entries()) denial.headers.append(name, value);
        return denial;
      }
      return NextResponse.json(
        { isPublic: access.isPublic, publishedAt: access.publishedAt },
        { headers: responseHeaders },
      );
    } catch (error) {
      console.error('Failed to fetch stage status', {
        stageId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'internal_error' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}

async function publicStatus(id: string): Promise<Response> {
  try {
    const access = await resolveStageAccess(id);

    // Tombstoned and never-existed must be indistinguishable: this endpoint is
    // unauthenticated, so an answer other than plain 404 would let anyone
    // confirm that a given id used to be a real course.
    if (!access) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Field names are the wire contract; they stay `isPublic` / `publishedAt`
    // regardless of which layer answered.
    return NextResponse.json({ isPublic: access.isPublic, publishedAt: access.publishedAt });
  } catch (error) {
    console.error('Failed to fetch stage status', {
      stageId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
