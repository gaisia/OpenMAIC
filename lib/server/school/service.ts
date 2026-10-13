/**
 * School directory operations. Routes and the gateway JWT method call these;
 * they do not talk to SQL themselves. Authorization uses the request
 * principal. Role changes take effect on the next request, because the
 * gateway method reads the bindings again while it authenticates.
 */
import { randomBytes } from 'node:crypto';

import type { OwnerPrincipal } from '@/lib/server/identity';
import { isStorableOwnerId } from '@/lib/server/identity/types';

import { assertClassOpen, assertClassTeacher, requireRole } from './authz';
import { SchoolError, SchoolNameTakenError } from './errors';
import { hasSchoolRole, parseSchoolRoleList, type SchoolRole } from './roles';
import type { SchoolClass, SchoolRepository, SchoolUser } from './types';

const USER_LIST_LIMIT = 1000;
const CLASS_NAME_MAX = 80;

export interface PublicUser {
  ownerId: string;
  displayName: string | null;
  email: string | null;
  roles: SchoolRole[];
  rolesManaged: boolean;
}

export interface PublicClass {
  id: string;
  name: string;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  teacherIds: string[];
  memberIds: string[];
}

export interface PublicRosterEntry {
  ownerId: string;
  displayName: string | null;
  email: string | null;
}

export function toPublicUser(user: SchoolUser): PublicUser {
  return {
    ownerId: user.ownerId,
    displayName: user.displayName,
    email: user.email,
    roles: user.roles,
    rolesManaged: user.rolesManaged,
  };
}

export function toPublicClass(schoolClass: SchoolClass): PublicClass {
  return {
    id: schoolClass.id,
    name: schoolClass.name,
    archived: schoolClass.archivedAt !== null,
    createdBy: schoolClass.createdBy,
    createdAt: schoolClass.createdAt,
    teacherIds: schoolClass.teacherIds,
    memberIds: schoolClass.memberIds,
  };
}

function newClassId(): string {
  return `cls_${randomBytes(8).toString('hex')}`;
}

export function parseClassName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SchoolError(400, 'INVALID_CLASS_NAME', 'name must be a string');
  }
  const name = value.trim();
  if (name.length === 0 || name.length > CLASS_NAME_MAX || name.includes('\u0000')) {
    throw new SchoolError(
      400,
      'INVALID_CLASS_NAME',
      `name must be 1 to ${CLASS_NAME_MAX} characters`,
    );
  }
  return name;
}

function requireOwnerId(value: unknown): string {
  if (!isStorableOwnerId(value)) {
    throw new SchoolError(
      400,
      'INVALID_OWNER_ID',
      'ownerId must be 1-256 printable non-space ASCII characters',
    );
  }
  return value;
}

async function roster(
  repo: SchoolRepository,
  ownerIds: readonly string[],
): Promise<PublicRosterEntry[]> {
  const users = await repo.getUsers(ownerIds);
  const byId = new Map(users.map((user) => [user.ownerId, user]));
  return ownerIds.map((ownerId) => {
    const user = byId.get(ownerId);
    return {
      ownerId,
      displayName: user?.displayName ?? null,
      email: user?.email ?? null,
    };
  });
}

export async function listUsers(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
): Promise<{ users: PublicUser[]; truncated: boolean }> {
  requireRole(principal, 'admin');
  const listed = await repo.listUsers(USER_LIST_LIMIT);
  return { users: listed.users.map(toPublicUser), truncated: listed.truncated };
}

/**
 * Replace a user's global roles. Creates a profile shell when the owner has
 * not logged in yet, so an admin can bind a role before the first visit.
 * Sets the managed flag: later JWTs do not overwrite these roles.
 */
export async function setUserRoles(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  ownerId: unknown,
  rolesValue: unknown,
): Promise<PublicUser> {
  requireRole(principal, 'admin');
  const id = requireOwnerId(ownerId);
  const parsed = parseSchoolRoleList(rolesValue);
  if (!parsed.ok) throw new SchoolError(400, 'INVALID_ROLES', parsed.reason);
  await repo.upsertProfile({ ownerId: id, displayName: null, email: null });
  const user = await repo.setRoles(id, parsed.roles, true);
  return toPublicUser(user);
}

export async function listClasses(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
): Promise<PublicClass[]> {
  const classes = await repo.listClasses();
  if (hasSchoolRole(principal, 'admin')) return classes.map(toPublicClass);
  if (hasSchoolRole(principal, 'teacher')) {
    return classes
      .filter((schoolClass) => schoolClass.teacherIds.includes(principal.ownerId))
      .map(toPublicClass);
  }
  throw new SchoolError(403, 'ROLE_REQUIRED', 'this action requires the teacher role');
}

export async function createClass(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  nameValue: unknown,
): Promise<PublicClass> {
  requireRole(principal, 'admin');
  const name = parseClassName(nameValue);
  try {
    const schoolClass = await repo.createClass({
      id: newClassId(),
      name,
      createdBy: principal.ownerId,
    });
    return toPublicClass(schoolClass);
  } catch (error) {
    if (error instanceof SchoolNameTakenError) {
      throw new SchoolError(409, 'CLASS_NAME_TAKEN', 'a class with this name already exists');
    }
    throw error;
  }
}

export async function archiveClass(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
): Promise<PublicClass> {
  requireRole(principal, 'admin');
  const schoolClass = await repo.archiveClass(classId);
  if (!schoolClass) throw new SchoolError(404, 'CLASS_NOT_FOUND', 'class not found');
  return toPublicClass(schoolClass);
}

async function loadTaughtClass(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
): Promise<SchoolClass> {
  return assertClassTeacher(principal, await repo.getClass(classId));
}

export async function listTeachers(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
): Promise<PublicRosterEntry[]> {
  const schoolClass = await loadTaughtClass(repo, principal, classId);
  return roster(repo, schoolClass.teacherIds);
}

export async function assignTeacher(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
  ownerId: unknown,
): Promise<PublicClass> {
  requireRole(principal, 'admin');
  const id = requireOwnerId(ownerId);
  const schoolClass = await repo.getClass(classId);
  if (!schoolClass) throw new SchoolError(404, 'CLASS_NOT_FOUND', 'class not found');
  assertClassOpen(schoolClass);
  const user = await repo.getUser(id);
  if (!user) throw new SchoolError(404, 'USER_NOT_FOUND', 'user not found');
  if (!user.roles.includes('teacher')) {
    throw new SchoolError(
      400,
      'NOT_A_TEACHER',
      'only a user with the teacher role can be assigned',
    );
  }
  return toPublicClass(await repo.addTeacher(classId, id, principal.ownerId));
}

export async function removeTeacher(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
  ownerId: unknown,
): Promise<PublicClass> {
  requireRole(principal, 'admin');
  const id = requireOwnerId(ownerId);
  const schoolClass = await repo.getClass(classId);
  if (!schoolClass) throw new SchoolError(404, 'CLASS_NOT_FOUND', 'class not found');
  return toPublicClass(await repo.removeTeacher(classId, id));
}

export async function listMembers(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
): Promise<PublicRosterEntry[]> {
  const schoolClass = await loadTaughtClass(repo, principal, classId);
  return roster(repo, schoolClass.memberIds);
}

export async function addMember(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
  ownerId: unknown,
): Promise<PublicClass> {
  const schoolClass = await loadTaughtClass(repo, principal, classId);
  assertClassOpen(schoolClass);
  const id = requireOwnerId(ownerId);
  const user = await repo.getUser(id);
  if (!user) throw new SchoolError(404, 'USER_NOT_FOUND', 'user not found');
  if (!user.roles.includes('student')) {
    throw new SchoolError(
      400,
      'NOT_A_STUDENT',
      'only a user with the student role can be a member',
    );
  }
  return toPublicClass(await repo.addMember(classId, id, principal.ownerId));
}

export async function removeMember(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  classId: string,
  ownerId: unknown,
): Promise<PublicClass> {
  const schoolClass = await loadTaughtClass(repo, principal, classId);
  assertClassOpen(schoolClass);
  const id = requireOwnerId(ownerId);
  return toPublicClass(await repo.removeMember(classId, id));
}
