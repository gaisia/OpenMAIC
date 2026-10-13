/**
 * US-01 / US-02 / US-04 / US-06 / US-07 against the school directory API and
 * the create-course hook. PostgreSQL is not required: the gateway method and
 * the handlers run on the in-memory directory.
 *
 * US-02's foreign course write stays on the upstream owner-bound stage routes,
 * which answer 404 for a stage the caller does not own (no existence oracle).
 * What this file pins is the school half: a student principal cannot create,
 * and does not hold course:publish.
 */
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import { OWNER_ROLES } from '@/lib/server/identity';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';
import { resetPersistenceHooksForTests } from '@/lib/server/persistence-hooks/registry';
import { authorizeSchoolCreate } from '@/lib/server/school/authorize-create';
import { rekeySchoolDirectory } from '@/lib/server/school/claims';
import {
  deleteMember,
  getClasses,
  getMembers,
  getUsers,
  postArchive,
  postClass,
  postMember,
  postTeacher,
  putUserRoles,
} from '@/lib/server/school/handlers';
import { MemorySchoolRepository } from '@/lib/server/school/memory-repository';
import { registerSchoolHost } from '@/lib/server/school/register';
import { setSchoolRepositoryForTests } from '@/lib/server/school/repository';
import { principalRoleSet } from '@/lib/server/school/roles';

const SECRET = 'test-secret-test-secret-test-secret';
const ISSUER = 'https://school.example/';
const AUDIENCE = 'openmaic';

let repo: MemorySchoolRepository;

async function sign(sub: string, roles: string[]): Promise<string> {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(SECRET));
}

function request(path: string, token?: string, body?: unknown): NextRequest {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(new URL(path, 'http://school.local'), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function bodyOf(
  response: Response,
): Promise<{ error?: { code: string }; [key: string]: unknown }> {
  return response.json() as Promise<{ error?: { code: string } }>;
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
  setSchoolRepositoryForTests(repo);
  registerSchoolHost();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
  resetPersistenceHooksForTests();
  resetClaimParticipantsForTests();
  setSchoolRepositoryForTests(undefined);
});

describe('school directory stories', () => {
  it('US-06 refuses a request with no JWT, a bad JWT, or only a site cookie', async () => {
    const missing = await getClasses(request('/api/school/classes'));
    const bad = await getClasses(
      request('/api/school/classes', `${await sign('ada', ['teacher'])}.tampered`),
    );
    const siteCookie = new NextRequest(new URL('/api/school/classes', 'http://school.local'), {
      headers: { cookie: 'access_token=not-a-role' },
    });
    const cookieOnly = await getClasses(siteCookie);
    expect(missing.status).toBe(401);
    expect(bad.status).toBe(401);
    expect(cookieOnly.status).toBe(401);
    expect((await bodyOf(missing)).error?.code).toBe('INVALID_CREDENTIAL');
    expect((await bodyOf(cookieOnly)).error?.code).toBe('INVALID_CREDENTIAL');
  });

  it('US-01 lets a teacher create a course and refuses a student', async () => {
    const teacherToken = await sign('ada', ['school:teacher']);
    const studentToken = await sign('bea', ['school:student']);
    const teacher = await resolveRequestOwner(request('/api/school/classes', teacherToken));
    const student = await resolveRequestOwner(request('/api/school/classes', studentToken));
    expect(teacher.ok).toBe(true);
    expect(student.ok).toBe(true);
    if (!teacher.ok || !student.ok) return;
    expect(teacher.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(true);
    expect(student.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(false);
    await expect(
      authorizeSchoolCreate(repo, {
        source: 'request',
        ownerId: teacher.principal.ownerId,
        principal: teacher.principal,
      }),
    ).resolves.toEqual({ allow: true });
    await expect(
      authorizeSchoolCreate(repo, {
        source: 'request',
        ownerId: student.principal.ownerId,
        principal: student.principal,
      }),
    ).resolves.toEqual({
      allow: false,
      message: 'only teachers and admins can create courses',
    });
    await expect(
      authorizeSchoolCreate(repo, { source: 'background', ownerId: student.principal.ownerId }),
    ).resolves.toMatchObject({ allow: false });
    await expect(
      authorizeSchoolCreate(repo, { source: 'background', ownerId: teacher.principal.ownerId }),
    ).resolves.toEqual({ allow: true });
  });

  it('US-02 a student principal is not a teacher and cannot publish', async () => {
    const student = await resolveRequestOwner(
      request('/api/school/classes', await sign('bea', ['student'])),
    );
    expect(student.ok).toBe(true);
    if (!student.ok) return;
    expect(student.principal.roles.has('school:student')).toBe(true);
    expect(student.principal.roles.has('school:teacher')).toBe(false);
    expect(student.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(false);
    expect(principalRoleSet(['student']).has(OWNER_ROLES.coursePublish)).toBe(false);
  });

  it('US-04 and US-07: only an admin creates a class; a teacher manages its members; a role change applies on the next request', async () => {
    const adminToken = await sign('ada', ['school:admin']);
    const teacherToken = await sign('ted', ['school:student']);
    const studentToken = await sign('bea', ['school:student']);
    const otherToken = await sign('otto', ['school:teacher']);

    const studentList = await getClasses(request('/api/school/classes', teacherToken));
    expect(studentList.status).toBe(403);

    const promoted = await putUserRoles(
      request('/api/school/users/user%3Ated/roles', adminToken, { roles: ['teacher'] }),
      'user:ted',
    );
    expect(promoted.status).toBe(200);
    const promotedBody = await bodyOf(promoted);
    expect(promotedBody.user).toMatchObject({
      ownerId: 'user:ted',
      roles: ['teacher'],
      rolesManaged: true,
    });

    const teacherAfter = await resolveRequestOwner(request('/api/school/classes', teacherToken));
    expect(teacherAfter.ok).toBe(true);
    if (!teacherAfter.ok) return;
    expect(teacherAfter.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(true);
    expect(teacherAfter.principal.roles.has('school:student')).toBe(false);

    const teacherCreate = await postClass(
      request('/api/school/classes', teacherToken, { name: 'Class-1' }),
    );
    expect(teacherCreate.status).toBe(403);
    expect((await bodyOf(teacherCreate)).error?.code).toBe('ROLE_REQUIRED');

    const created = await postClass(
      request('/api/school/classes', adminToken, { name: 'Class-1' }),
    );
    expect(created.status).toBe(201);
    const createdBody = await bodyOf(created);
    const classId = (createdBody.class as { id: string }).id;
    expect(createdBody.class).toMatchObject({ name: 'Class-1', archived: false });

    const duplicate = await postClass(
      request('/api/school/classes', adminToken, { name: 'class-1' }),
    );
    expect(duplicate.status).toBe(409);

    await putUserRoles(
      request('/api/school/users/x/roles', adminToken, { roles: ['student'] }),
      'user:bea',
    );
    const assign = await postTeacher(
      request(`/api/school/classes/${classId}/teachers`, adminToken, { ownerId: 'user:ted' }),
      classId,
    );
    expect(assign.status).toBe(200);

    const studentAdd = await postMember(
      request(`/api/school/classes/${classId}/members`, studentToken, { ownerId: 'user:bea' }),
      classId,
    );
    expect(studentAdd.status).toBe(403);

    const added = await postMember(
      request(`/api/school/classes/${classId}/members`, teacherToken, { ownerId: 'user:bea' }),
      classId,
    );
    expect(added.status).toBe(200);
    expect((await bodyOf(added)).class).toMatchObject({ memberIds: ['user:bea'] });

    const otherAdd = await postMember(
      request(`/api/school/classes/${classId}/members`, otherToken, { ownerId: 'user:bea' }),
      classId,
    );
    expect(otherAdd.status).toBe(403);
    expect((await bodyOf(otherAdd)).error?.code).toBe('NOT_CLASS_TEACHER');

    const removed = await deleteMember(
      request(`/api/school/classes/${classId}/members/user%3Abea`, teacherToken),
      classId,
      'user:bea',
    );
    expect(removed.status).toBe(200);
    const members = await getMembers(
      request(`/api/school/classes/${classId}/members`, teacherToken),
      classId,
    );
    expect((await bodyOf(members)).members).toEqual([]);

    const teacherClasses = await getClasses(request('/api/school/classes', teacherToken));
    expect(teacherClasses.status).toBe(200);
    expect((await bodyOf(teacherClasses)).classes).toEqual([
      expect.objectContaining({ id: classId, name: 'Class-1' }),
    ]);

    const archived = await postArchive(
      request(`/api/school/classes/${classId}/archive`, adminToken),
      classId,
    );
    expect(archived.status).toBe(200);
    expect((await bodyOf(archived)).class).toMatchObject({ archived: true });
    const addAfterArchive = await postMember(
      request(`/api/school/classes/${classId}/members`, teacherToken, { ownerId: 'user:bea' }),
      classId,
    );
    expect(addAfterArchive.status).toBe(409);

    const users = await getUsers(request('/api/school/users', adminToken));
    expect(users.status).toBe(200);
    const teacherList = await getUsers(request('/api/school/users', teacherToken));
    expect(teacherList.status).toBe(403);
  });

  it('does not rekey school rows when the tables are absent', async () => {
    const queries: string[] = [];
    const moved = await rekeySchoolDirectory(
      {
        async query(text: string) {
          queries.push(text);
          return { rows: [{ present: false }] };
        },
      },
      'from',
      'to',
    );
    expect(moved).toBe(0);
    expect(queries).toHaveLength(1);
  });
});
