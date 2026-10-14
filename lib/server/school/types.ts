import type { SchoolRole } from './roles';

export interface SchoolUser {
  ownerId: string;
  displayName: string | null;
  email: string | null;
  roles: SchoolRole[];
  /** When true, an admin set the roles and later logins do not copy the JWT claim. */
  rolesManaged: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolClass {
  id: string;
  name: string;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  teacherIds: string[];
  memberIds: string[];
}

/** Classes and directly named students a course is assigned to. */
export interface CourseAssignment {
  classIds: string[];
  studentIds: string[];
}

/**
 * How one learner meets a course. `classAssign` is current membership of an
 * assigned class, not a snapshot taken when the class was assigned.
 */
export interface AssignmentMatch {
  classAssign: boolean;
  studentAssign: boolean;
}

/** Courses a learner currently matches, with the classes that grant each one. */
export interface LearnerAssignment {
  stageId: string;
  classIds: string[];
  direct: boolean;
}

export interface SchoolRepository {
  getUser(ownerId: string): Promise<SchoolUser | null>;
  getUsers(ownerIds: readonly string[]): Promise<SchoolUser[]>;
  /** At most `limit` users, oldest first. `truncated` when more exist. */
  listUsers(limit: number): Promise<{ users: SchoolUser[]; truncated: boolean }>;
  /**
   * Insert the user, or refresh display name and email when the new value is
   * non-null. Does not change roles. Returns the stored user.
   */
  upsertProfile(input: {
    ownerId: string;
    displayName: string | null;
    email: string | null;
  }): Promise<SchoolUser>;
  /**
   * Replace the role set. `managed: true` sticks (an admin write). `managed:
   * false` leaves an existing managed flag set, so a login cannot unlock it.
   */
  setRoles(ownerId: string, roles: readonly SchoolRole[], managed: boolean): Promise<SchoolUser>;
  /**
   * Record a verified login. Profile fields refresh. Roles are replaced from
   * `claimedRoles` only while the user is not admin-managed.
   */
  syncFromLogin(input: {
    ownerId: string;
    displayName: string | null;
    email: string | null;
    claimedRoles: readonly SchoolRole[];
  }): Promise<SchoolRole[]>;
  createClass(input: { id: string; name: string; createdBy: string }): Promise<SchoolClass>;
  getClass(id: string): Promise<SchoolClass | null>;
  listClasses(): Promise<SchoolClass[]>;
  /** Sets `archivedAt` if it was null. Returns null when the id does not exist. */
  archiveClass(id: string): Promise<SchoolClass | null>;
  addTeacher(classId: string, ownerId: string, assignedBy: string): Promise<SchoolClass>;
  removeTeacher(classId: string, ownerId: string): Promise<SchoolClass>;
  addMember(classId: string, ownerId: string, addedBy: string): Promise<SchoolClass>;
  removeMember(classId: string, ownerId: string): Promise<SchoolClass>;
  /** Idempotent. The class must already exist. */
  assignCourseClass(stageId: string, classId: string, assignedBy: string): Promise<void>;
  /** Idempotent when the row is already gone. */
  removeCourseClass(stageId: string, classId: string): Promise<void>;
  /** Idempotent. Each owner must already be a school user. */
  assignCourseStudents(
    stageId: string,
    ownerIds: readonly string[],
    assignedBy: string,
  ): Promise<void>;
  /** Idempotent when the row is already gone. */
  removeCourseStudent(stageId: string, ownerId: string): Promise<void>;
  getCourseAssignment(stageId: string): Promise<CourseAssignment>;
  /**
   * Current class membership or a direct row. Joining a class after the
   * assignment still matches; leaving the class drops `classAssign` only.
   */
  assignmentMatch(stageId: string, ownerId: string): Promise<AssignmentMatch>;
  /** Every course the learner currently matches, class hits and direct hits. */
  listLearnerAssignments(ownerId: string): Promise<LearnerAssignment[]>;
}
