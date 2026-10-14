/**
 * Route handlers for school publish, assignment, and the student course list.
 * Tests call these without the Next bundler. Each `route.ts` re-exports one.
 */
import type { NextRequest } from 'next/server';

import { getCourseCatalog } from './course-catalog';
import {
  assignClass,
  assignStudents,
  getAssignments,
  listMyCourses,
  publishCourse,
  unassignClass,
  unassignStudent,
  unpublishCourse,
} from './courses';
import { readJsonBody, schoolJson, withSchool } from './http';

export function getMyCourses(req: NextRequest): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const courses = await listMyCourses(ctx.repo, await getCourseCatalog(), ctx.principal);
    return schoolJson({ courses }, 200, ctx.headers);
  });
}

export function postPublish(req: NextRequest, stageId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const course = await publishCourse(await getCourseCatalog(), ctx.principal, stageId);
    return schoolJson({ course }, 200, ctx.headers);
  });
}

export function postUnpublish(req: NextRequest, stageId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const course = await unpublishCourse(await getCourseCatalog(), ctx.principal, stageId);
    return schoolJson({ course }, 200, ctx.headers);
  });
}

export function getCourseAssignments(req: NextRequest, stageId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const assignments = await getAssignments(
      ctx.repo,
      await getCourseCatalog(),
      ctx.principal,
      stageId,
    );
    return schoolJson({ assignments }, 200, ctx.headers);
  });
}

export function postClassAssignment(req: NextRequest, stageId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const body = (await readJsonBody(req)) as { classId?: unknown } | null;
    const classId = body && typeof body === 'object' ? body.classId : undefined;
    const assignments = await assignClass(
      ctx.repo,
      await getCourseCatalog(),
      ctx.principal,
      stageId,
      classId,
    );
    return schoolJson({ assignments }, 200, ctx.headers);
  });
}

export function deleteClassAssignment(
  req: NextRequest,
  stageId: string,
  classId: string,
): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const assignments = await unassignClass(
      ctx.repo,
      await getCourseCatalog(),
      ctx.principal,
      stageId,
      classId,
    );
    return schoolJson({ assignments }, 200, ctx.headers);
  });
}

export function postStudentAssignment(req: NextRequest, stageId: string): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const body = (await readJsonBody(req)) as { ownerIds?: unknown } | null;
    const ownerIds = body && typeof body === 'object' ? body.ownerIds : undefined;
    const assignments = await assignStudents(
      ctx.repo,
      await getCourseCatalog(),
      ctx.principal,
      stageId,
      ownerIds,
    );
    return schoolJson({ assignments }, 200, ctx.headers);
  });
}

export function deleteStudentAssignment(
  req: NextRequest,
  stageId: string,
  ownerId: string,
): Promise<Response> {
  return withSchool(req, async (ctx) => {
    const assignments = await unassignStudent(
      ctx.repo,
      await getCourseCatalog(),
      ctx.principal,
      stageId,
      ownerId,
    );
    return schoolJson({ assignments }, 200, ctx.headers);
  });
}
