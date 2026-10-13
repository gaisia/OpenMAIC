/**
 * Refuse course creation for anyone who is not a teacher or an admin.
 *
 * Wired to `authorizeCreate`. A refusal rolls the create transaction back and
 * the stage routes answer `403 CREATE_REFUSED`. Request actors use the
 * principal the gateway method just resolved (database roles overlay the JWT
 * on that request). Background actors have no principal, so the decision
 * reads the stored bindings for the owner id.
 */
import type { CreateDecision, DocumentActor } from '@/lib/server/persistence-hooks/types';

import { mayCreateCourse, schoolRolesFromPrincipal } from './roles';
import type { SchoolRepository } from './types';

const REFUSED: CreateDecision = {
  allow: false,
  message: 'only teachers and admins can create courses',
};

export async function authorizeSchoolCreate(
  repo: SchoolRepository,
  actor: DocumentActor,
): Promise<CreateDecision> {
  const roles =
    actor.source === 'request'
      ? schoolRolesFromPrincipal(actor.principal)
      : ((await repo.getUser(actor.ownerId))?.roles ?? []);
  return mayCreateCourse(roles) ? { allow: true } : REFUSED;
}
