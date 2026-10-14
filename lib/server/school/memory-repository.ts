/**
 * In-memory school directory. Production uses `pg-repository.ts`. Tests use
 * this so the role and class rules run without PostgreSQL. The two
 * implementations share {@link SchoolRepository}.
 */
import { SchoolNameTakenError } from './errors';
import { sortSchoolRoles, type SchoolRole } from './roles';
import type {
  AssignmentMatch,
  CourseAssignment,
  LearnerAssignment,
  SchoolClass,
  SchoolRepository,
  SchoolUser,
} from './types';

interface AssignmentRow {
  assignedBy: string;
  assignedAt: string;
}

function cloneUser(user: SchoolUser): SchoolUser {
  return { ...user, roles: [...user.roles] };
}

function cloneClass(schoolClass: SchoolClass): SchoolClass {
  return {
    ...schoolClass,
    teacherIds: [...schoolClass.teacherIds],
    memberIds: [...schoolClass.memberIds],
  };
}

export class MemorySchoolRepository implements SchoolRepository {
  private readonly users = new Map<string, SchoolUser>();
  private readonly classes = new Map<string, SchoolClass>();
  /** stageId → classId → row */
  private readonly classAssignments = new Map<string, Map<string, AssignmentRow>>();
  /** stageId → ownerId → row */
  private readonly studentAssignments = new Map<string, Map<string, AssignmentRow>>();

  async getUser(ownerId: string): Promise<SchoolUser | null> {
    const user = this.users.get(ownerId);
    return user ? cloneUser(user) : null;
  }

  async getUsers(ownerIds: readonly string[]): Promise<SchoolUser[]> {
    const wanted = new Set(ownerIds);
    return [...this.users.values()].filter((user) => wanted.has(user.ownerId)).map(cloneUser);
  }

  async listUsers(limit: number): Promise<{ users: SchoolUser[]; truncated: boolean }> {
    const users = [...this.users.values()].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.ownerId.localeCompare(b.ownerId)
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    );
    return {
      users: users.slice(0, limit).map(cloneUser),
      truncated: users.length > limit,
    };
  }

  async upsertProfile(input: {
    ownerId: string;
    displayName: string | null;
    email: string | null;
  }): Promise<SchoolUser> {
    const now = new Date().toISOString();
    const existing = this.users.get(input.ownerId);
    if (!existing) {
      const created: SchoolUser = {
        ownerId: input.ownerId,
        displayName: input.displayName,
        email: input.email,
        roles: [],
        rolesManaged: false,
        createdAt: now,
        updatedAt: now,
      };
      this.users.set(input.ownerId, created);
      return cloneUser(created);
    }
    if (input.displayName !== null) existing.displayName = input.displayName;
    if (input.email !== null) existing.email = input.email;
    existing.updatedAt = now;
    return cloneUser(existing);
  }

  async setRoles(
    ownerId: string,
    roles: readonly SchoolRole[],
    managed: boolean,
  ): Promise<SchoolUser> {
    const existing = this.users.get(ownerId);
    if (!existing) throw new Error(`school user ${ownerId} does not exist`);
    existing.roles = sortSchoolRoles(roles);
    if (managed) existing.rolesManaged = true;
    existing.updatedAt = new Date().toISOString();
    return cloneUser(existing);
  }

  async syncFromLogin(input: {
    ownerId: string;
    displayName: string | null;
    email: string | null;
    claimedRoles: readonly SchoolRole[];
  }): Promise<SchoolRole[]> {
    const user = await this.upsertProfile(input);
    if (user.rolesManaged) return user.roles;
    const updated = await this.setRoles(input.ownerId, input.claimedRoles, false);
    return updated.roles;
  }

  async createClass(input: { id: string; name: string; createdBy: string }): Promise<SchoolClass> {
    const key = input.name.toLowerCase();
    for (const schoolClass of this.classes.values()) {
      if (!schoolClass.archivedAt && schoolClass.name.toLowerCase() === key) {
        throw new SchoolNameTakenError();
      }
    }
    const created: SchoolClass = {
      id: input.id,
      name: input.name,
      archivedAt: null,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      teacherIds: [],
      memberIds: [],
    };
    this.classes.set(created.id, created);
    return cloneClass(created);
  }

  async getClass(id: string): Promise<SchoolClass | null> {
    const schoolClass = this.classes.get(id);
    return schoolClass ? cloneClass(schoolClass) : null;
  }

  async listClasses(): Promise<SchoolClass[]> {
    return [...this.classes.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(cloneClass);
  }

  async archiveClass(id: string): Promise<SchoolClass | null> {
    const schoolClass = this.classes.get(id);
    if (!schoolClass) return null;
    if (!schoolClass.archivedAt) schoolClass.archivedAt = new Date().toISOString();
    return cloneClass(schoolClass);
  }

  async addTeacher(classId: string, ownerId: string, _assignedBy: string): Promise<SchoolClass> {
    const schoolClass = this.require(classId);
    if (!schoolClass.teacherIds.includes(ownerId)) schoolClass.teacherIds.push(ownerId);
    return cloneClass(schoolClass);
  }

  async removeTeacher(classId: string, ownerId: string): Promise<SchoolClass> {
    const schoolClass = this.require(classId);
    schoolClass.teacherIds = schoolClass.teacherIds.filter((id) => id !== ownerId);
    return cloneClass(schoolClass);
  }

  async addMember(classId: string, ownerId: string, _addedBy: string): Promise<SchoolClass> {
    const schoolClass = this.require(classId);
    if (!schoolClass.memberIds.includes(ownerId)) schoolClass.memberIds.push(ownerId);
    return cloneClass(schoolClass);
  }

  async removeMember(classId: string, ownerId: string): Promise<SchoolClass> {
    const schoolClass = this.require(classId);
    schoolClass.memberIds = schoolClass.memberIds.filter((id) => id !== ownerId);
    return cloneClass(schoolClass);
  }

  async assignCourseClass(stageId: string, classId: string, assignedBy: string): Promise<void> {
    this.require(classId);
    const rows = this.classAssignments.get(stageId) ?? new Map<string, AssignmentRow>();
    if (!rows.has(classId)) {
      rows.set(classId, { assignedBy, assignedAt: new Date().toISOString() });
    }
    this.classAssignments.set(stageId, rows);
  }

  async removeCourseClass(stageId: string, classId: string): Promise<void> {
    this.classAssignments.get(stageId)?.delete(classId);
  }

  async assignCourseStudents(
    stageId: string,
    ownerIds: readonly string[],
    assignedBy: string,
  ): Promise<void> {
    const rows = this.studentAssignments.get(stageId) ?? new Map<string, AssignmentRow>();
    for (const ownerId of ownerIds) {
      if (!this.users.has(ownerId)) throw new Error(`school user ${ownerId} does not exist`);
      if (!rows.has(ownerId)) {
        rows.set(ownerId, { assignedBy, assignedAt: new Date().toISOString() });
      }
    }
    this.studentAssignments.set(stageId, rows);
  }

  async removeCourseStudent(stageId: string, ownerId: string): Promise<void> {
    this.studentAssignments.get(stageId)?.delete(ownerId);
  }

  async getCourseAssignment(stageId: string): Promise<CourseAssignment> {
    return {
      classIds: [...(this.classAssignments.get(stageId)?.keys() ?? [])].sort(),
      studentIds: [...(this.studentAssignments.get(stageId)?.keys() ?? [])].sort(),
    };
  }

  async assignmentMatch(stageId: string, ownerId: string): Promise<AssignmentMatch> {
    const studentAssign = this.studentAssignments.get(stageId)?.has(ownerId) === true;
    let classAssign = false;
    for (const classId of this.classAssignments.get(stageId)?.keys() ?? []) {
      const schoolClass = this.classes.get(classId);
      if (schoolClass?.memberIds.includes(ownerId)) {
        classAssign = true;
        break;
      }
    }
    return { classAssign, studentAssign };
  }

  async listLearnerAssignments(ownerId: string): Promise<LearnerAssignment[]> {
    const byStage = new Map<string, LearnerAssignment>();
    for (const [stageId, classes] of this.classAssignments) {
      const classIds = [...classes.keys()].filter((classId) =>
        this.classes.get(classId)?.memberIds.includes(ownerId),
      );
      if (classIds.length === 0) continue;
      byStage.set(stageId, { stageId, classIds: classIds.sort(), direct: false });
    }
    for (const [stageId, students] of this.studentAssignments) {
      if (!students.has(ownerId)) continue;
      const existing = byStage.get(stageId);
      if (existing) existing.direct = true;
      else byStage.set(stageId, { stageId, classIds: [], direct: true });
    }
    return [...byStage.values()].sort((a, b) => (a.stageId < b.stageId ? -1 : 1));
  }

  private require(classId: string): SchoolClass {
    const schoolClass = this.classes.get(classId);
    if (!schoolClass) throw new Error(`school class ${classId} does not exist`);
    return schoolClass;
  }
}
