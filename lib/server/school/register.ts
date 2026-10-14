/**
 * Register school identity when `SCHOOL_JWT_*` is set.
 *
 * Called from `instrumentation.ts` before owner-identity validation. With the
 * variables unset this does nothing, and the process keeps the upstream
 * anonymous, single-user, or shared-team behavior. When they are set, the
 * gateway JWT method is the only owner auth method, anonymous fallback is
 * off, students cannot create courses, school directory rows follow an
 * anonymous-owner claim, and the library plus direct stage reads follow
 * `canRead` (published and assigned). Public share links stay disabled.
 */
import { registerClaimParticipant } from '@/lib/persistence/owner-claims';
import { configureOwnerAuthentication } from '@/lib/server/identity';
import { createSchoolGatewayJwtMethod } from '@/lib/server/identity/host/gateway-jwt';
import { configurePersistenceHooks } from '@/lib/server/persistence-hooks';

import { authorizeSchoolCreate } from './authorize-create';
import { rekeySchoolDirectory } from './claims';
import { listSchoolLibraryStageIds } from './courses';
import { readSchoolJwtConfig } from './jwt-config';
import { getSchoolRepository } from './repository';

function readSwitch(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be "true", "1", "false" or "0", got ${JSON.stringify(env[name])}.`);
}

/** Page navigations mint an anonymous cookie unless this is explicitly off. Unset means on. */
function anonymousPremintEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OWNER_ANONYMOUS_PREMINT?.trim();
  if (!raw) return true;
  return readSwitch(env, 'OWNER_ANONYMOUS_PREMINT');
}

function assertSchoolDeployment(env: NodeJS.ProcessEnv): void {
  if (readSwitch(env, 'OWNER_SINGLE_USER')) {
    throw new Error(
      'School identity cannot run with OWNER_SINGLE_USER=true. Set OWNER_SINGLE_USER=false ' +
        '(Docker Compose turns it on in docker-compose.defaults.env; override it in .env.local) ' +
        'and do not set PERSISTENCE_SHARED_OWNER_ID. ACCESS_CODE may stay as a site gate; it does not grant a role.',
    );
  }
  if (env.PERSISTENCE_SHARED_OWNER_ID?.trim()) {
    throw new Error(
      'School identity cannot run with PERSISTENCE_SHARED_OWNER_ID. Unset it so each signed-in user is their own owner.',
    );
  }
  if (anonymousPremintEnabled(env)) {
    throw new Error(
      'School identity turns anonymous fallback off. Set OWNER_ANONYMOUS_PREMINT=false so page ' +
        'responses do not mint an anonymous owner cookie.',
    );
  }
}

/** Register school auth, or do nothing when school identity is not configured. */
export function registerSchoolHost(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = readSchoolJwtConfig(env);
  if (!config) return false;
  assertSchoolDeployment(env);
  configureOwnerAuthentication({
    methods: [createSchoolGatewayJwtMethod(config)],
    anonymousFallback: false,
  });
  configurePersistenceHooks({
    name: 'school-class',
    async authorizeCreate(_tx, actor) {
      return authorizeSchoolCreate(await getSchoolRepository(), actor);
    },
    library: {
      name: 'school-class',
      list: (context) => listSchoolLibraryStageIds(context),
    },
  });
  registerClaimParticipant({
    name: 'school-directory',
    order: 1000,
    rekey: (tx, fromOwnerId, toOwnerId) => rekeySchoolDirectory(tx, fromOwnerId, toOwnerId),
  });
  return true;
}
