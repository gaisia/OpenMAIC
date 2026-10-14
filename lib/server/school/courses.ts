/**
 * Publish, assign, and read courses in school mode.
 *
 * Publish writes the upstream publication columns. Assignments are school
 * rows and may be saved on a draft; they do not let a student read until the
 * course is published. Whole-class assignment follows current membership.
 *
 * Public share links are not a grant. School mode does not mint one, and a
 * stage id by itself never satisfies {@link canRead}.
 */
import type { OwnerPrincipal } from '@/lib/server/identity';
import { OWNER_ROLES, principalHasRole } from '@/lib/server/identity';
import type { LibraryListContext } from '@/lib/server/persistence-hooks/types';

import { assertClassOpen, assertClassTeacher } from './authz';
import {
  canRead,
  decideCourseRead,
  type CourseReadDecision,
  type CourseSnapshot,
} from './can-read';
import { getCourseCatalog, type CourseCatalog } from './course-catalog';
import { SchoolError } from './errors';
import { schoolJwtEnvIsSet } from './jwt-config';
import { getSchoolRepository } from './repository';
import { hasSchoolRole, schoolRolesFromPrincipal, type SchoolRole } from './roles';
import type { SchoolRepository } from './types';

/** Product posture. There is no environment switch that turns a public link back on. */
export const SCHOOL_SHARE = {
  publicLink: 'disabled' as const,
  requirePublishedAndAssigned: true,
  entryByAssignmentOnly: true,
  inviteCode: 'disabled' as const,
};

const STAGE_ID_MAX = 256;
const MAX_STUDENT_IDS = 100;

export interface PublishedCourse {
  stageId: string;
  name: string;
  published: boolean;
  publishedAt: number | null;
}

export interface AssignmentView {
  stageId: string;
  published: boolean;
  publishedAt: number | null;
  classes: { id: string; name: string }[];
  students: { ownerId: string; displayName: string | null }[];
}

export interface MyCourse {
  stageId: string;
  name: string;
  publishedAt: number;
  classIds: string[];
  /** True when a course↔student row names this learner, whether or not a class does too. */
  direct: boolean;
}

function subjectOf(principal: OwnerPrincipal): {
  authenticated: boolean;
  ownerId: string;
  roles: SchoolRole[];
} {
  return {
    authenticated: principal.kind !== 'anonymous',
    ownerId: principal.ownerId,
    roles: schoolRolesFromPrincipal(principal),
  };
}

export function parseStageId(value: string): string {
  if (
    value.length === 0 ||
    value.length > STAGE_ID_MAX ||
    value.includes('\u0000') ||
    /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new SchoolError(400, 'INVALID_STAGE_ID', 'stage id is not usable');
  }
  return value;
}

function assertPublisher(principal: OwnerPrincipal): void {
  if (!hasSchoolRole(principal, 'teacher') && !hasSchoolRole(principal, 'admin')) {
    throw new SchoolError(403, 'ROLE_REQUIRED', 'this action requires the teacher role');
  }
  if (!principalHasRole(principal, OWNER_ROLES.coursePublish)) {
    throw new SchoolError(403, 'PUBLISH_FORBIDDEN', 'principal lacks course:publish');
  }
}

/** Students cannot assign. An admin who is not the teaching owner cannot either. */
function assertAssigner(principal: OwnerPrincipal): void {
  if (!hasSchoolRole(principal, 'teacher')) {
    throw new SchoolError(403, 'ROLE_REQUIRED', 'only a teacher who owns the course can assign it');
  }
  if (!principalHasRole(principal, OWNER_ROLES.coursePublish)) {
    throw new SchoolError(403, 'PUBLISH_FORBIDDEN', 'principal lacks course:publish');
  }
}

async function requireOwnedCourse(
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
): Promise<CourseSnapshot> {
  const course = await catalog.get(stageId);
  if (!course) throw new SchoolError(404, 'COURSE_NOT_FOUND', 'course not found');
  if (course.ownerId !== principal.ownerId) {
    throw new SchoolError(403, 'NOT_COURSE_OWNER', 'only the course owner can do that');
  }
  return course;
}

function toPublished(course: CourseSnapshot): PublishedCourse {
  return {
    stageId: course.stageId,
    name: course.name,
    published: course.publishedAt !== null,
    publishedAt: course.publishedAt,
  };
}

export async function publishCourse(
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
): Promise<PublishedCourse> {
  assertPublisher(principal);
  const course = await requireOwnedCourse(catalog, principal, parseStageId(stageId));
  if (course.publishedAt !== null) return toPublished(course);
  const published = await catalog.setPublished(course.stageId, Date.now());
  if (!published) throw new SchoolError(404, 'COURSE_NOT_FOUND', 'course not found');
  return toPublished(published);
}

export async function unpublishCourse(
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
): Promise<PublishedCourse> {
  assertPublisher(principal);
  const course = await requireOwnedCourse(catalog, principal, parseStageId(stageId));
  if (course.publishedAt === null) return toPublished(course);
  const unpublished = await catalog.setPublished(course.stageId, null);
  if (!unpublished) throw new SchoolError(404, 'COURSE_NOT_FOUND', 'course not found');
  return toPublished(unpublished);
}

async function assignmentView(
  repo: SchoolRepository,
  course: CourseSnapshot,
): Promise<AssignmentView> {
  const assignment = await repo.getCourseAssignment(course.stageId);
  const classes = [];
  for (const classId of assignment.classIds) {
    const schoolClass = await repo.getClass(classId);
    if (!schoolClass) continue;
    classes.push({ id: schoolClass.id, name: schoolClass.name });
  }
  const users = await repo.getUsers(assignment.studentIds);
  const byId = new Map(users.map((user) => [user.ownerId, user]));
  return {
    stageId: course.stageId,
    published: course.publishedAt !== null,
    publishedAt: course.publishedAt,
    classes,
    students: assignment.studentIds.map((ownerId) => ({
      ownerId,
      displayName: byId.get(ownerId)?.displayName ?? null,
    })),
  };
}

export async function getAssignments(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
): Promise<AssignmentView> {
  if (!hasSchoolRole(principal, 'teacher') && !hasSchoolRole(principal, 'admin')) {
    throw new SchoolError(403, 'ROLE_REQUIRED', 'this action requires the teacher role');
  }
  const course = await catalog.get(parseStageId(stageId));
  if (!course) throw new SchoolError(404, 'COURSE_NOT_FOUND', 'course not found');
  if (!hasSchoolRole(principal, 'admin') && course.ownerId !== principal.ownerId) {
    throw new SchoolError(403, 'NOT_COURSE_OWNER', 'only the course owner can do that');
  }
  return assignmentView(repo, course);
}

export async function assignClass(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
  classId: unknown,
): Promise<AssignmentView> {
  assertAssigner(principal);
  if (typeof classId !== 'string' || classId.length === 0) {
    throw new SchoolError(400, 'INVALID_CLASS_ID', 'classId is required');
  }
  const course = await requireOwnedCourse(catalog, principal, parseStageId(stageId));
  const schoolClass = assertClassTeacher(principal, await repo.getClass(classId));
  assertClassOpen(schoolClass);
  await repo.assignCourseClass(course.stageId, schoolClass.id, principal.ownerId);
  return assignmentView(repo, course);
}

export async function unassignClass(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
  classId: string,
): Promise<AssignmentView> {
  assertAssigner(principal);
  const course = await requireOwnedCourse(catalog, principal, parseStageId(stageId));
  await repo.removeCourseClass(course.stageId, classId);
  return assignmentView(repo, course);
}

function parseOwnerIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : null;
  if (!raw || raw.some((item) => typeof item !== 'string')) {
    throw new SchoolError(400, 'INVALID_OWNER_ID', 'ownerIds must be an array of owner ids');
  }
  const ownerIds = [...new Set(raw.map((item) => item.trim()))];
  if (ownerIds.length === 0 || ownerIds.length > MAX_STUDENT_IDS) {
    throw new SchoolError(
      400,
      'INVALID_OWNER_ID',
      `ownerIds must contain 1 to ${MAX_STUDENT_IDS} ids`,
    );
  }
  return ownerIds;
}

async function assertTaughtStudent(
  repo: SchoolRepository,
  teacherId: string,
  ownerId: string,
): Promise<void> {
  const user = await repo.getUser(ownerId);
  if (!user || !user.roles.includes('student')) {
    throw new SchoolError(
      403,
      'STUDENT_NOT_IN_TAUGHT_CLASS',
      'a direct assignment must name a student in a class you teach',
    );
  }
  const classes = await repo.listClasses();
  const taught = classes.some(
    (schoolClass) =>
      schoolClass.archivedAt === null &&
      schoolClass.teacherIds.includes(teacherId) &&
      schoolClass.memberIds.includes(ownerId),
  );
  if (!taught) {
    throw new SchoolError(
      403,
      'STUDENT_NOT_IN_TAUGHT_CLASS',
      'a direct assignment must name a student in a class you teach',
    );
  }
}

export async function assignStudents(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
  ownerIdsValue: unknown,
): Promise<AssignmentView> {
  assertAssigner(principal);
  const ownerIds = parseOwnerIds(ownerIdsValue);
  const course = await requireOwnedCourse(catalog, principal, parseStageId(stageId));
  for (const ownerId of ownerIds) {
    await assertTaughtStudent(repo, principal.ownerId, ownerId);
  }
  await repo.assignCourseStudents(course.stageId, ownerIds, principal.ownerId);
  return assignmentView(repo, course);
}

export async function unassignStudent(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
  ownerId: string,
): Promise<AssignmentView> {
  assertAssigner(principal);
  const course = await requireOwnedCourse(catalog, principal, parseStageId(stageId));
  await repo.removeCourseStudent(course.stageId, ownerId);
  return assignmentView(repo, course);
}

export async function listMyCourses(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
): Promise<MyCourse[]> {
  if (!hasSchoolRole(principal, 'student')) {
    throw new SchoolError(403, 'ROLE_REQUIRED', 'my courses is a student list');
  }
  return readableCourses(repo, catalog, principal.ownerId);
}

async function readableCourses(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  ownerId: string,
): Promise<MyCourse[]> {
  const hits = await repo.listLearnerAssignments(ownerId);
  const courses = await catalog.getMany(hits.map((hit) => hit.stageId));
  const byId = new Map(courses.map((course) => [course.stageId, course]));
  const listed: MyCourse[] = [];
  for (const hit of hits) {
    const course = byId.get(hit.stageId);
    if (!course || course.publishedAt === null) continue;
    if (
      !canRead({
        authenticated: true,
        published: true,
        classAssign: hit.classIds.length > 0,
        studentAssign: hit.direct,
      })
    ) {
      continue;
    }
    listed.push({
      stageId: course.stageId,
      name: course.name,
      publishedAt: course.publishedAt,
      classIds: hit.classIds,
      direct: hit.direct,
    });
  }
  return listed;
}

/** Stage ids `GET /api/stages` should list. Students see only {@link canRead} courses. */
export async function listSchoolLibraryStageIds(context: LibraryListContext): Promise<string[]> {
  const roles = schoolRolesFromPrincipal(context.principal);
  if (roles.includes('student') && !roles.includes('teacher') && !roles.includes('admin')) {
    const repo = await getSchoolRepository();
    const catalog = await getCourseCatalog();
    const courses = await readableCourses(repo, catalog, context.principal.ownerId);
    return courses.map((course) => course.stageId);
  }
  return context.ownedStageIds();
}

export async function decidePrincipalRead(
  repo: SchoolRepository,
  catalog: CourseCatalog,
  principal: OwnerPrincipal,
  stageId: string,
): Promise<CourseReadDecision> {
  const subject = subjectOf(principal);
  if (!subject.authenticated) {
    return decideCourseRead({
      subject,
      course: null,
      classAssign: false,
      studentAssign: false,
    });
  }
  let course: CourseSnapshot | null = null;
  try {
    course = await catalog.get(parseStageId(stageId));
  } catch (error) {
    if (error instanceof SchoolError && error.code === 'INVALID_STAGE_ID') {
      return {
        allow: false,
        status: 404,
        code: 'COURSE_NOT_FOUND',
        message: 'course not found',
      };
    }
    throw error;
  }
  const match = course
    ? await repo.assignmentMatch(course.stageId, principal.ownerId)
    : { classAssign: false, studentAssign: false };
  return decideCourseRead({
    subject,
    course,
    classAssign: match.classAssign,
    studentAssign: match.studentAssign,
  });
}

/**
 * School-mode refusal for a direct stage-id read, or null when the caller may
 * read (or school identity is off, in which case the upstream rule stands).
 */
export async function schoolDocumentReadDenial(
  principal: OwnerPrincipal,
  stageId: string,
): Promise<Response | null> {
  if (!schoolJwtEnvIsSet()) return null;
  const decision = await decidePrincipalRead(
    await getSchoolRepository(),
    await getCourseCatalog(),
    principal,
    stageId,
  );
  if (decision.allow) return null;
  return Response.json(
    { error: { code: decision.code, message: decision.message } },
    { status: decision.status, headers: { 'cache-control': 'private, no-store' } },
  );
}
