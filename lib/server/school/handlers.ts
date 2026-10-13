/**
 * Route handlers for `/api/school/*`. Kept beside the service so tests can
 * call them without going through the Next bundler, and so each `route.ts`
 * stays a thin re-export.
 */
import type { NextRequest } from 'next/server';

import { readJsonBody, schoolJson, withSchool } from './http';
import {
  addMember,
  archiveClass,
  assignTeacher,
  createClass,
  listClasses,
  listMembers,
  listTeachers,
  listUsers,
  removeMember,
  removeTeacher,
  setUserRoles,
} from './service';

export function getUsers(req: NextRequest): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const listed = await listUsers(ctx.repo, ctx.principal);
    return schoolJson(listed, 200, ctx.headers);
  });
}

export function putUserRoles(req: NextRequest, ownerId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const body = (await readJsonBody(req)) as { roles?: unknown } | null;
    const roles = body && typeof body === 'object' ? body.roles : undefined;
    const user = await setUserRoles(ctx.repo, ctx.principal, ownerId, roles);
    return schoolJson({ user }, 200, ctx.headers);
  });
}

export function getClasses(req: NextRequest): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const classes = await listClasses(ctx.repo, ctx.principal);
    return schoolJson({ classes }, 200, ctx.headers);
  });
}

export function postClass(req: NextRequest): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const body = (await readJsonBody(req)) as { name?: unknown } | null;
    const name = body && typeof body === 'object' ? body.name : undefined;
    const schoolClass = await createClass(ctx.repo, ctx.principal, name);
    return schoolJson({ class: schoolClass }, 201, ctx.headers);
  });
}

export function postArchive(req: NextRequest, classId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const schoolClass = await archiveClass(ctx.repo, ctx.principal, classId);
    return schoolJson({ class: schoolClass }, 200, ctx.headers);
  });
}

export function getTeachers(req: NextRequest, classId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const teachers = await listTeachers(ctx.repo, ctx.principal, classId);
    return schoolJson({ teachers }, 200, ctx.headers);
  });
}

export function postTeacher(req: NextRequest, classId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const body = (await readJsonBody(req)) as { ownerId?: unknown } | null;
    const ownerId = body && typeof body === 'object' ? body.ownerId : undefined;
    const schoolClass = await assignTeacher(ctx.repo, ctx.principal, classId, ownerId);
    return schoolJson({ class: schoolClass }, 200, ctx.headers);
  });
}

export function deleteTeacher(
  req: NextRequest,
  classId: string,
  ownerId: string,
): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const schoolClass = await removeTeacher(ctx.repo, ctx.principal, classId, ownerId);
    return schoolJson({ class: schoolClass }, 200, ctx.headers);
  });
}

export function getMembers(req: NextRequest, classId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const members = await listMembers(ctx.repo, ctx.principal, classId);
    return schoolJson({ members }, 200, ctx.headers);
  });
}

export function postMember(req: NextRequest, classId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const body = (await readJsonBody(req)) as { ownerId?: unknown } | null;
    const ownerId = body && typeof body === 'object' ? body.ownerId : undefined;
    const schoolClass = await addMember(ctx.repo, ctx.principal, classId, ownerId);
    return schoolJson({ class: schoolClass }, 200, ctx.headers);
  });
}

export function deleteMember(
  req: NextRequest,
  classId: string,
  ownerId: string,
): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const schoolClass = await removeMember(ctx.repo, ctx.principal, classId, ownerId);
    return schoolJson({ class: schoolClass }, 200, ctx.headers);
  });
}
