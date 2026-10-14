/**
 * Who may read a course in school mode.
 *
 * Students use {@link canRead} exactly:
 * published AND (class assignment OR student assignment) AND authenticated.
 * A teacher may also read a course they own, including a draft. An admin may
 * read any live course (inspection). Nobody else may, and a copied stage id
 * does not add a grant.
 */
import type { SchoolRole } from './roles';

export interface CanReadInput {
  authenticated: boolean;
  published: boolean;
  /** Learner is currently a member of a class the course is assigned to. */
  classAssign: boolean;
  /** Learner is named on a course↔student row. */
  studentAssign: boolean;
}

/** The student read rule. Staff bypasses live in {@link decideCourseRead}. */
export function canRead(input: CanReadInput): boolean {
  return input.authenticated && input.published && (input.classAssign || input.studentAssign);
}

export interface CourseSnapshot {
  stageId: string;
  ownerId: string;
  name: string;
  /** Epoch millis. Null while the course is unpublished. */
  publishedAt: number | null;
}

export interface CourseReadSubject {
  authenticated: boolean;
  ownerId: string;
  roles: readonly SchoolRole[];
}

export type CourseReadDecision =
  | { readonly allow: true; readonly via: 'admin' | 'owner' | 'assignment' }
  | {
      readonly allow: false;
      readonly status: 401 | 403 | 404;
      readonly code: string;
      readonly message: string;
    };

const NOT_READABLE: CourseReadDecision = {
  allow: false,
  status: 403,
  code: 'COURSE_NOT_READABLE',
  message: '无权学习该课程或课程未开放',
};

/**
 * Full read decision for one course.
 *
 * Missing and deleted courses are the same 404. An existing course the caller
 * may not learn is 403, including a draft that already has assignments.
 */
export function decideCourseRead(input: {
  subject: CourseReadSubject;
  course: CourseSnapshot | null;
  classAssign: boolean;
  studentAssign: boolean;
}): CourseReadDecision {
  if (!input.subject.authenticated) {
    return {
      allow: false,
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'sign in to open this course',
    };
  }
  if (!input.course) {
    return {
      allow: false,
      status: 404,
      code: 'COURSE_NOT_FOUND',
      message: 'course not found',
    };
  }
  if (input.subject.roles.includes('admin')) return { allow: true, via: 'admin' };
  if (input.subject.roles.includes('teacher') && input.course.ownerId === input.subject.ownerId) {
    return { allow: true, via: 'owner' };
  }
  if (
    input.subject.roles.includes('student') &&
    canRead({
      authenticated: true,
      published: input.course.publishedAt !== null,
      classAssign: input.classAssign,
      studentAssign: input.studentAssign,
    })
  ) {
    return { allow: true, via: 'assignment' };
  }
  return NOT_READABLE;
}
