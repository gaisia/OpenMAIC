/**
 * The document route is the classroom's direct stage-id read. School mode must
 * refuse it unless canRead, not only hide the course from the library list.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handlePersistenceRequest } from '@/app/api/persistence/[...path]/route';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import { principalRoleSet } from '@/lib/server/school/roles';
import { MemoryCourseCatalog, setCourseCatalogForTests } from '@/lib/server/school/course-catalog';
import { MemorySchoolRepository } from '@/lib/server/school/memory-repository';
import { registerSchoolHost } from '@/lib/server/school/register';
import { setSchoolRepositoryForTests } from '@/lib/server/school/repository';
import { resetPersistenceHooksForTests } from '@/lib/server/persistence-hooks/registry';

const SECRET = 'test-secret-test-secret-test-secret';
const ISSUER = 'https://school.example/';
const AUDIENCE = 'openmaic';
const STAGE = 'stage-direct';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

let pool: PGlitePool;
let repo: MemorySchoolRepository;
let catalog: MemoryCourseCatalog;

async function sign(sub: string, roles: string[]): Promise<string> {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(SECRET));
}

function read(stageId: string, token?: string): Request {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(`http://localhost/api/persistence/documents/${stageId}`, { headers });
}

beforeEach(async () => {
  vi.stubEnv('SCHOOL_JWT_ISSUER', ISSUER);
  vi.stubEnv('SCHOOL_JWT_AUDIENCE', AUDIENCE);
  vi.stubEnv('SCHOOL_JWT_SECRET', SECRET);
  vi.stubEnv('OWNER_SINGLE_USER', 'false');
  vi.stubEnv('OWNER_ANONYMOUS_PREMINT', 'false');
  vi.stubEnv('DATABASE_URL', `postgres://school-read-${randomUUID()}`);
  vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
  vi.stubEnv('OWNER_SINGLE_USER_ID', '');
  const db = new PGlite();
  await db.waitReady;
  pool = new PGlitePool(db);
  repo = new MemorySchoolRepository();
  catalog = new MemoryCourseCatalog();
  setSchoolRepositoryForTests(repo);
  setCourseCatalogForTests(catalog);
  registerSchoolHost();
  await getServerPersistenceProvider(process.env.DATABASE_URL ?? '', () => pool as never);
  await repo.syncFromLogin({
    ownerId: 'user:ted',
    displayName: null,
    email: null,
    claimedRoles: ['teacher'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:bea',
    displayName: null,
    email: null,
    claimedRoles: ['student'],
  });
  await repo.createClass({ id: 'cls_1', name: 'Class-1', createdBy: 'user:ted' });
  await repo.addTeacher('cls_1', 'user:ted', 'user:ted');
  await repo.addMember('cls_1', 'user:bea', 'user:ted');
  const now = 1_800_000_000_000;
  await createOwnerBoundDocumentStore({
    pool,
    ownerId: 'user:ted',
    principal: {
      ownerId: 'user:ted',
      kind: 'user',
      roles: principalRoleSet(['teacher']),
      assurance: 'verified',
    },
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  }).saveDocument({
    stage: { id: STAGE, name: 'C', createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: 'C',
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: null });
});

afterEach(async () => {
  await pool.end();
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
  resetPersistenceHooksForTests();
  resetClaimParticipantsForTests();
  setSchoolRepositoryForTests(undefined);
  setCourseCatalogForTests(undefined);
});

describe('school direct document read', () => {
  it('refuses an unpublished or unassigned stage id and serves it once canRead holds', async () => {
    const student = await sign('bea', ['school:student']);
    const anonymous = await handlePersistenceRequest(read(STAGE), {
      poolFactory: () => pool as never,
    });
    expect(anonymous.status).toBe(401);

    const draft = await handlePersistenceRequest(read(STAGE, student), {
      poolFactory: () => pool as never,
    });
    expect(draft.status).toBe(403);
    await expect(draft.json()).resolves.toMatchObject({
      error: { code: 'COURSE_NOT_READABLE' },
    });

    await repo.assignCourseClass(STAGE, 'cls_1', 'user:ted');
    const assignedDraft = await handlePersistenceRequest(read(STAGE, student), {
      poolFactory: () => pool as never,
    });
    expect(assignedDraft.status).toBe(403);

    catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: 1_800_000_000_000 });
    const open = await handlePersistenceRequest(read(STAGE, student), {
      poolFactory: () => pool as never,
    });
    expect(open.status).toBe(200);
    await expect(open.json()).resolves.toMatchObject({ stage: { id: STAGE, name: 'C' } });
  });
});
