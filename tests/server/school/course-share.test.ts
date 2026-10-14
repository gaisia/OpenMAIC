/**
 * US-CS-01 … US-CS-08 for publish, assignment, and canRead.
 *
 * PostgreSQL is not required. Publication is an in-memory stand-in for
 * `stage_meta`, and the directory is the in-memory school repository. The
 * direct-read cases call `schoolDocumentReadDenial`, which is the gate the
 * document, stage-meta, status, and classroom-media routes use.
 */
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { resetPersistenceHooksForTests } from '@/lib/server/persistence-hooks/registry';
import { canRead } from '@/lib/server/school/can-read';
import {
  deleteClassAssignment,
  deleteStudentAssignment,
  getCourseAssignments,
  getMyCourses,
  postClassAssignment,
  postPublish,
  postStudentAssignment,
  postUnpublish,
} from '@/lib/server/school/course-handlers';
import { MemoryCourseCatalog, setCourseCatalogForTests } from '@/lib/server/school/course-catalog';
import {
  SCHOOL_SHARE,
  listSchoolLibraryStageIds,
  schoolDocumentReadDenial,
} from '@/lib/server/school/courses';
import { MemorySchoolRepository } from '@/lib/server/school/memory-repository';
import { registerSchoolHost } from '@/lib/server/school/register';
import { setSchoolRepositoryForTests } from '@/lib/server/school/repository';

const SECRET = 'test-secret-test-secret-test-secret';
const ISSUER = 'https://school.example/';
const AUDIENCE = 'openmaic';
const STAGE = 'stage-c';

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

function request(
  path: string,
  token?: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(new URL(path, 'http://school.local'), {
    method,
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function bodyOf(response: Response): Promise<{
  error?: { code: string; message?: string };
  courses?: { stageId: string; name: string; direct: boolean; classIds: string[] }[];
  course?: { published: boolean; publishedAt: number | null };
  assignments?: {
    published: boolean;
    classes: { id: string }[];
    students: { ownerId: string }[];
  };
}> {
  return response.json() as Promise<ReturnType<typeof bodyOf>>;
}

async function principal(token: string): Promise<OwnerPrincipal> {
  const resolved = await resolveRequestOwner(request('/api/school/courses', token));
  if (!resolved.ok) throw new Error('expected a signed-in principal');
  return resolved.principal;
}

async function readDenial(token: string, stageId = STAGE): Promise<Response | null> {
  return schoolDocumentReadDenial(await principal(token), stageId);
}

beforeEach(() => {
  vi.stubEnv('SCHOOL_JWT_ISSUER', ISSUER);
  vi.stubEnv('SCHOOL_JWT_AUDIENCE', AUDIENCE);
  vi.stubEnv('SCHOOL_JWT_SECRET', SECRET);
  vi.stubEnv('OWNER_SINGLE_USER', 'false');
  vi.stubEnv('OWNER_ANONYMOUS_PREMINT', 'false');
  vi.stubEnv('DATABASE_URL', 'postgres://openmaic:openmaic@127.0.0.1:5432/openmaic');
  vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
  vi.stubEnv('OWNER_SINGLE_USER_ID', '');
  repo = new MemorySchoolRepository();
  catalog = new MemoryCourseCatalog();
  setSchoolRepositoryForTests(repo);
  setCourseCatalogForTests(catalog);
  registerSchoolHost();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
  resetPersistenceHooksForTests();
  resetClaimParticipantsForTests();
  setSchoolRepositoryForTests(undefined);
  setCourseCatalogForTests(undefined);
});

async function seed(): Promise<{
  teacher: string;
  bea: string;
  dee: string;
  eve: string;
  admin: string;
}> {
  await repo.syncFromLogin({
    ownerId: 'user:ada',
    displayName: 'Ada',
    email: null,
    claimedRoles: ['admin'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:ted',
    displayName: 'Ted',
    email: null,
    claimedRoles: ['teacher'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:bea',
    displayName: 'Bea',
    email: null,
    claimedRoles: ['student'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:dee',
    displayName: 'Dee',
    email: null,
    claimedRoles: ['student'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:eve',
    displayName: 'Eve',
    email: null,
    claimedRoles: ['student'],
  });
  await repo.createClass({ id: 'cls_1', name: 'Class-1', createdBy: 'user:ada' });
  await repo.addTeacher('cls_1', 'user:ted', 'user:ada');
  await repo.addMember('cls_1', 'user:bea', 'user:ted');
  await repo.addMember('cls_1', 'user:dee', 'user:ted');
  catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: null });
  return {
    teacher: await sign('ted', ['school:teacher']),
    bea: await sign('bea', ['school:student']),
    dee: await sign('dee', ['school:student']),
    eve: await sign('eve', ['school:student']),
    admin: await sign('ada', ['school:admin']),
  };
}

describe('school course share', () => {
  it('canRead is published AND assigned AND authenticated', () => {
    expect(
      canRead({ authenticated: true, published: true, classAssign: true, studentAssign: false }),
    ).toBe(true);
    expect(
      canRead({ authenticated: true, published: true, classAssign: false, studentAssign: true }),
    ).toBe(true);
    expect(
      canRead({ authenticated: true, published: false, classAssign: true, studentAssign: true }),
    ).toBe(false);
    expect(
      canRead({ authenticated: false, published: true, classAssign: true, studentAssign: true }),
    ).toBe(false);
    expect(
      canRead({ authenticated: true, published: true, classAssign: false, studentAssign: false }),
    ).toBe(false);
    expect(SCHOOL_SHARE).toMatchObject({
      publicLink: 'disabled',
      requirePublishedAndAssigned: true,
      entryByAssignmentOnly: true,
      inviteCode: 'disabled',
    });
  });

  it('US-CS-01 publish does not admit students until an assignment exists, and a draft assignment stays inert', async () => {
    const { teacher, bea } = await seed();
    const studentPublish = await postPublish(
      request(`/api/school/courses/${STAGE}/publish`, bea),
      STAGE,
    );
    expect(studentPublish.status).toBe(403);
    expect((await bodyOf(studentPublish)).error?.code).toBe('ROLE_REQUIRED');

    const pre = await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, teacher, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    expect(pre.status).toBe(200);
    expect((await bodyOf(await getMyCourses(request('/api/school/courses', bea)))).courses).toEqual(
      [],
    );
    expect((await readDenial(bea))?.status).toBe(403);

    const published = await postPublish(
      request(`/api/school/courses/${STAGE}/publish`, teacher),
      STAGE,
    );
    expect(published.status).toBe(200);
    const publishedBody = await bodyOf(published);
    expect(publishedBody.course).toMatchObject({ published: true, name: 'C' });
    expect(typeof publishedBody.course?.publishedAt).toBe('number');

    const again = await postPublish(
      request(`/api/school/courses/${STAGE}/publish`, teacher),
      STAGE,
    );
    expect((await bodyOf(again)).course?.publishedAt).toBe(publishedBody.course?.publishedAt);

    const mine = await bodyOf(await getMyCourses(request('/api/school/courses', bea)));
    expect(mine.courses).toEqual([
      expect.objectContaining({ stageId: STAGE, name: 'C', classIds: ['cls_1'], direct: false }),
    ]);
    expect(await readDenial(bea)).toBeNull();
  });

  it('US-CS-02 whole-class assignment is dynamic, and cancelling it drops the class', async () => {
    const { teacher, bea, dee, eve } = await seed();
    await postPublish(request(`/api/school/courses/${STAGE}/publish`, teacher), STAGE);
    await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, teacher, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );

    expect(await readDenial(bea)).toBeNull();
    expect(await readDenial(dee)).toBeNull();
    const outsider = await bodyOf(await getMyCourses(request('/api/school/courses', eve)));
    expect(outsider.courses).toEqual([]);
    expect((await readDenial(eve))?.status).toBe(403);

    await repo.addMember('cls_1', 'user:eve', 'user:ted');
    const late = await bodyOf(await getMyCourses(request('/api/school/courses', eve)));
    expect(late.courses?.map((course) => course.stageId)).toEqual([STAGE]);
    expect(await readDenial(eve)).toBeNull();

    const removed = await deleteClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes/cls_1`, teacher, {
        method: 'DELETE',
      }),
      STAGE,
      'cls_1',
    );
    expect(removed.status).toBe(200);
    expect((await bodyOf(removed)).assignments?.classes).toEqual([]);
    expect((await bodyOf(await getMyCourses(request('/api/school/courses', bea)))).courses).toEqual(
      [],
    );
    expect((await readDenial(bea))?.status).toBe(403);
    expect((await readDenial(eve))?.status).toBe(403);
  });

  it('US-CS-03 a direct assignment is the union with the class, and cancelling it drops only that grant', async () => {
    const { teacher, bea, dee } = await seed();
    await postPublish(request(`/api/school/courses/${STAGE}/publish`, teacher), STAGE);
    const onlyBea = await postStudentAssignment(
      request(`/api/school/courses/${STAGE}/assignments/students`, teacher, {
        body: { ownerIds: ['user:bea'] },
      }),
      STAGE,
    );
    expect(onlyBea.status).toBe(200);
    expect(await readDenial(bea)).toBeNull();
    expect((await readDenial(dee))?.status).toBe(403);

    await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, teacher, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    expect(await readDenial(dee)).toBeNull();

    await deleteStudentAssignment(
      request(`/api/school/courses/${STAGE}/assignments/students/user:bea`, teacher, {
        method: 'DELETE',
      }),
      STAGE,
      'user:bea',
    );
    expect(await readDenial(bea)).toBeNull();

    await deleteClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes/cls_1`, teacher, {
        method: 'DELETE',
      }),
      STAGE,
      'cls_1',
    );
    expect((await readDenial(bea))?.status).toBe(403);
    expect((await readDenial(dee))?.status).toBe(403);
  });

  it('US-CS-04 unpublish hides the course and keeps the assignment for a later publish', async () => {
    const { teacher, bea } = await seed();
    await postPublish(request(`/api/school/courses/${STAGE}/publish`, teacher), STAGE);
    await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, teacher, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    const unpublished = await postUnpublish(
      request(`/api/school/courses/${STAGE}/unpublish`, teacher),
      STAGE,
    );
    expect((await bodyOf(unpublished)).course).toMatchObject({
      published: false,
      publishedAt: null,
    });
    expect((await bodyOf(await getMyCourses(request('/api/school/courses', bea)))).courses).toEqual(
      [],
    );
    expect((await readDenial(bea))?.status).toBe(403);
    const kept = await bodyOf(
      await getCourseAssignments(
        request(`/api/school/courses/${STAGE}/assignments`, teacher),
        STAGE,
      ),
    );
    expect(kept.assignments?.classes.map((item) => item.id)).toEqual(['cls_1']);
    expect(kept.assignments?.published).toBe(false);

    await postPublish(request(`/api/school/courses/${STAGE}/publish`, teacher), STAGE);
    expect(await readDenial(bea)).toBeNull();
  });

  it('US-CS-05 a forwarded stage id does not grant a read', async () => {
    const { teacher, dee } = await seed();
    await postPublish(request(`/api/school/courses/${STAGE}/publish`, teacher), STAGE);
    await postStudentAssignment(
      request(`/api/school/courses/${STAGE}/assignments/students`, teacher, {
        body: { ownerIds: ['user:bea'] },
      }),
      STAGE,
    );
    const forwarded = await readDenial(dee);
    expect(forwarded?.status).toBe(403);
    expect((await bodyOf(forwarded!)).error).toMatchObject({
      code: 'COURSE_NOT_READABLE',
      message: '无权学习该课程或课程未开放',
    });
    expect((await readDenial(dee, 'stage-missing'))?.status).toBe(404);
  });

  it('US-CS-06 unsigned calls are 401, and school mode is what closes the public read', async () => {
    await seed();
    const missing = await getMyCourses(request('/api/school/courses'));
    expect(missing.status).toBe(401);
    expect((await bodyOf(missing)).error?.code).toBe('INVALID_CREDENTIAL');

    const anonymous: OwnerPrincipal = {
      ownerId: 'anon:visitor',
      kind: 'anonymous',
      roles: new Set(),
      assurance: 'unverified-legacy',
    };
    const denied = await schoolDocumentReadDenial(anonymous, STAGE);
    expect(denied?.status).toBe(401);

    vi.stubEnv('SCHOOL_JWT_ISSUER', '');
    vi.stubEnv('SCHOOL_JWT_AUDIENCE', '');
    vi.stubEnv('SCHOOL_JWT_SECRET', '');
    expect(await schoolDocumentReadDenial(anonymous, STAGE)).toBeNull();
  });

  it('US-CS-07 students cannot publish or assign; the teacher list is their own courses', async () => {
    const { teacher, bea } = await seed();
    const assign = await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, bea, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    expect(assign.status).toBe(403);
    const unpublish = await postUnpublish(
      request(`/api/school/courses/${STAGE}/unpublish`, bea),
      STAGE,
    );
    expect(unpublish.status).toBe(403);
    const teacherMine = await getMyCourses(request('/api/school/courses', teacher));
    expect(teacherMine.status).toBe(403);

    const teacherPrincipal = await principal(teacher);
    const studentPrincipal = await principal(bea);
    await postPublish(request(`/api/school/courses/${STAGE}/publish`, teacher), STAGE);
    await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, teacher, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    await expect(
      listSchoolLibraryStageIds({
        principal: studentPrincipal,
        queryable: {} as never,
        ownedStageIds: async () => ['stage-not-assigned'],
      }),
    ).resolves.toEqual([STAGE]);
    await expect(
      listSchoolLibraryStageIds({
        principal: teacherPrincipal,
        queryable: {} as never,
        ownedStageIds: async () => ['stage-owned'],
      }),
    ).resolves.toEqual(['stage-owned']);
  });

  it('US-CS-08 leaving the class drops a whole-class grant and keeps a direct one', async () => {
    const { teacher, bea } = await seed();
    await postPublish(request(`/api/school/courses/${STAGE}/publish`, teacher), STAGE);
    await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, teacher, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    await repo.removeMember('cls_1', 'user:bea');
    expect((await readDenial(bea))?.status).toBe(403);

    await repo.addMember('cls_1', 'user:bea', 'user:ted');
    await postStudentAssignment(
      request(`/api/school/courses/${STAGE}/assignments/students`, teacher, {
        body: { ownerIds: ['user:bea'] },
      }),
      STAGE,
    );
    await repo.removeMember('cls_1', 'user:bea');
    expect(await readDenial(bea)).toBeNull();
    const mine = await bodyOf(await getMyCourses(request('/api/school/courses', bea)));
    expect(mine.courses).toEqual([
      expect.objectContaining({ stageId: STAGE, direct: true, classIds: [] }),
    ]);
  });

  it('refuses a direct assignment outside the teacher classes, and lets an admin inspect', async () => {
    const { teacher, admin } = await seed();
    await repo.syncFromLogin({
      ownerId: 'user:zoe',
      displayName: 'Zoe',
      email: null,
      claimedRoles: ['student'],
    });
    const outsider = await postStudentAssignment(
      request(`/api/school/courses/${STAGE}/assignments/students`, teacher, {
        body: { ownerIds: ['user:zoe'] },
      }),
      STAGE,
    );
    expect(outsider.status).toBe(403);
    expect((await bodyOf(outsider)).error?.code).toBe('STUDENT_NOT_IN_TAUGHT_CLASS');

    const archived = await repo.archiveClass('cls_1');
    expect(archived?.archivedAt).toBeTruthy();
    const toArchived = await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, teacher, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    expect(toArchived.status).toBe(409);

    const inspected = await getCourseAssignments(
      request(`/api/school/courses/${STAGE}/assignments`, admin),
      STAGE,
    );
    expect(inspected.status).toBe(200);
    const adminAssign = await postClassAssignment(
      request(`/api/school/courses/${STAGE}/assignments/classes`, admin, {
        body: { classId: 'cls_1' },
      }),
      STAGE,
    );
    expect(adminAssign.status).toBe(403);
  });
});
