/**
 * School roles for the class-teaching fork.
 *
 * Upstream core only knows `course:publish` and `admin`. Teacher and student
 * are not core roles: this module keeps them as the custom strings
 * `school:teacher` and `school:student` (and `school:admin` beside core
 * `admin`). A request principal carries those strings plus `course:publish`
 * for teachers and admins, so the existing publish routes admit them and
 * refuse students.
 *
 * Roles are global. A person is not a teacher in one class and a student in
 * another. Class membership is a separate table.
 */

import type { OwnerPrincipal } from '@/lib/server/identity';
import { OWNER_ROLES } from '@/lib/server/identity';

export const SCHOOL_ROLES = ['admin', 'teacher', 'student'] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

/** Custom role strings written onto the owner principal. */
export const SCHOOL_ROLE_NAMES: Record<SchoolRole, string> = {
  admin: 'school:admin',
  teacher: 'school:teacher',
  student: 'school:student',
};

const ROLE_ORDER: readonly SchoolRole[] = SCHOOL_ROLES;

const TOKEN_TO_ROLE: Readonly<Record<string, SchoolRole>> = {
  admin: 'admin',
  'school:admin': 'admin',
  teacher: 'teacher',
  'school:teacher': 'teacher',
  student: 'student',
  'school:student': 'student',
};

export type ParsedSchoolRoles =
  | { readonly ok: true; readonly roles: SchoolRole[] }
  | { readonly ok: false; readonly reason: string };

/** Stable order: admin, teacher, student. */
export function sortSchoolRoles(roles: readonly SchoolRole[]): SchoolRole[] {
  const present = new Set(roles);
  return ROLE_ORDER.filter((role) => present.has(role));
}

export function isSchoolRole(value: unknown): value is SchoolRole {
  return typeof value === 'string' && (SCHOOL_ROLES as readonly string[]).includes(value);
}

/**
 * Interpret one JWT roles/groups claim.
 *
 * Unknown strings are ignored (an identity provider often sends groups this
 * app does not use). `teacher` and `student` together are rejected: those two
 * roles are mutually exclusive. `admin` may sit beside either.
 * A missing claim is an empty role set, not an error.
 */
export function parseSchoolRoleClaim(value: unknown): ParsedSchoolRoles {
  if (value === undefined || value === null) return { ok: true, roles: [] };
  let tokens: string[];
  if (typeof value === 'string') {
    tokens = value.split(/[\s,]+/).filter((token) => token.length > 0);
  } else if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string')) {
      return { ok: false, reason: 'roles claim must be strings' };
    }
    tokens = value as string[];
  } else {
    return { ok: false, reason: 'roles claim must be a string or an array of strings' };
  }
  const roles = new Set<SchoolRole>();
  for (const token of tokens) {
    const role = TOKEN_TO_ROLE[token];
    if (role) roles.add(role);
  }
  if (roles.has('teacher') && roles.has('student')) {
    return { ok: false, reason: 'teacher and student cannot be combined' };
  }
  return { ok: true, roles: sortSchoolRoles([...roles]) };
}

/** Parse a JSON body `{ roles: [...] }` of canonical role names (`teacher`, not `school:teacher`). */
export function parseSchoolRoleList(value: unknown): ParsedSchoolRoles {
  if (!Array.isArray(value) || value.some((item) => !isSchoolRole(item))) {
    return {
      ok: false,
      reason: 'roles must be an array of "admin", "teacher", and "student"',
    };
  }
  return parseSchoolRoleClaim(value);
}

/**
 * Roles the owner principal carries for `roles`.
 * Teachers and admins receive `course:publish`. Admins also receive core `admin`.
 */
export function principalRoleSet(roles: readonly SchoolRole[]): Set<string> {
  const set = new Set<string>();
  for (const role of roles) set.add(SCHOOL_ROLE_NAMES[role]);
  if (roles.includes('admin')) set.add(OWNER_ROLES.admin);
  if (roles.includes('admin') || roles.includes('teacher')) set.add(OWNER_ROLES.coursePublish);
  return set;
}

/** School roles implied by a principal. Core `admin` counts as school admin. */
export function schoolRolesFromPrincipal(principal: OwnerPrincipal): SchoolRole[] {
  const roles: SchoolRole[] = [];
  if (principal.roles.has(SCHOOL_ROLE_NAMES.admin) || principal.roles.has(OWNER_ROLES.admin)) {
    roles.push('admin');
  }
  if (principal.roles.has(SCHOOL_ROLE_NAMES.teacher)) roles.push('teacher');
  if (principal.roles.has(SCHOOL_ROLE_NAMES.student)) roles.push('student');
  return roles;
}

export function hasSchoolRole(principal: OwnerPrincipal, role: SchoolRole): boolean {
  return schoolRolesFromPrincipal(principal).includes(role);
}

export function mayCreateCourse(roles: readonly SchoolRole[]): boolean {
  return roles.includes('teacher') || roles.includes('admin');
}
