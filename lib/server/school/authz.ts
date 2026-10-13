/**
 * Authorization helpers for school APIs.
 *
 * `requireRole` reads the request principal (the gateway method already
 * overlaid database role bindings). `assertClassTeacher` allows a school
 * admin, or a teacher assigned to that class. Students, and teachers of
 * another class, are refused.
 */

import type { OwnerPrincipal } from '@/lib/server/identity';

import { SchoolError } from './errors';
import { hasSchoolRole, type SchoolRole } from './roles';
import type { SchoolClass } from './types';

export function requireRole(principal: OwnerPrincipal, role: SchoolRole): void {
  if (!hasSchoolRole(principal, role)) {
    throw new SchoolError(403, 'ROLE_REQUIRED', `this action requires the ${role} role`);
  }
}

/**
 * The class a teacher-or-admin action may touch.
 *
 * Admins receive 404 when the id does not exist. Anyone else receives 403,
 * including when the id is unknown, so a teacher cannot probe the class list
 * by id. The product matrix gives admins every class and teachers only the
 * classes they teach.
 */
export function assertClassTeacher(
  principal: OwnerPrincipal,
  schoolClass: SchoolClass | null,
): SchoolClass {
  if (hasSchoolRole(principal, 'admin')) {
    if (!schoolClass) throw new SchoolError(404, 'CLASS_NOT_FOUND', 'class not found');
    return schoolClass;
  }
  if (
    !schoolClass ||
    !hasSchoolRole(principal, 'teacher') ||
    !schoolClass.teacherIds.includes(principal.ownerId)
  ) {
    throw new SchoolError(
      403,
      'NOT_CLASS_TEACHER',
      'only a teacher of this class, or an admin, can do that',
    );
  }
  return schoolClass;
}

export function assertClassOpen(schoolClass: SchoolClass): void {
  if (schoolClass.archivedAt) {
    throw new SchoolError(409, 'CLASS_ARCHIVED', 'class is archived');
  }
}
