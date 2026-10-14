/**
 * PostgreSQL school directory. Statements stay parameterized. Role changes
 * and login sync run in one transaction so a reader never sees a user with
 * the managed flag and a half-written role set.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { SchoolNameTakenError } from './errors';
import { ensureSchoolSchema } from './schema';
import { isSchoolRole, sortSchoolRoles, type SchoolRole } from './roles';
import type {
  AssignmentMatch,
  CourseAssignment,
  LearnerAssignment,
  SchoolClass,
  SchoolRepository,
  SchoolUser,
} from './types';

const USER_COLUMNS = `
  u.owner_id,
  u.display_name,
  u.email,
  u.roles_managed,
  u.created_at,
  u.updated_at,
  COALESCE(
    (SELECT array_agg(b.role ORDER BY b.role)
       FROM school_role_bindings b
      WHERE b.owner_id = u.owner_id),
    '{}'
  ) AS roles
`;

const CLASS_COLUMNS = `
  c.id,
  c.name,
  c.archived_at,
  c.created_by,
  c.created_at,
  COALESCE(
    (SELECT array_agg(t.owner_id ORDER BY t.assigned_at, t.owner_id)
       FROM school_class_teachers t
      WHERE t.class_id = c.id),
    '{}'
  ) AS teacher_ids,
  COALESCE(
    (SELECT array_agg(m.owner_id ORDER BY m.added_at, m.owner_id)
       FROM school_class_members m
      WHERE m.class_id = c.id),
    '{}'
  ) AS member_ids
`;

interface UserRow extends Record<string, unknown> {
  owner_id: string;
  display_name: string | null;
  email: string | null;
  roles_managed: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  roles: string[] | null;
}

interface ClassRow extends Record<string, unknown> {
  id: string;
  name: string;
  archived_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  teacher_ids: string[] | null;
  member_ids: string[] | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toUser(row: UserRow): SchoolUser {
  const roles = sortSchoolRoles((row.roles ?? []).filter(isSchoolRole));
  return {
    ownerId: row.owner_id,
    displayName: row.display_name,
    email: row.email,
    roles,
    rolesManaged: row.roles_managed === true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toClass(row: ClassRow): SchoolClass {
  return {
    id: row.id,
    name: row.name,
    archivedAt: row.archived_at === null ? null : iso(row.archived_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    teacherIds: row.teacher_ids ?? [],
    memberIds: row.member_ids ?? [],
  };
}

function pgError(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const row = error as { code?: unknown; constraint?: unknown };
  return {
    code: typeof row.code === 'string' ? row.code : undefined,
    constraint: typeof row.constraint === 'string' ? row.constraint : undefined,
  };
}

export class PgSchoolRepository implements SchoolRepository {
  private readonly withTransaction: <T>(body: (queryable: Queryable) => Promise<T>) => Promise<T>;

  constructor(private readonly db: Queryable & ConnectableQueryable) {
    this.withTransaction = nodePostgresTransaction(db);
  }

  async getUser(ownerId: string): Promise<SchoolUser | null> {
    const result = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM school_users u WHERE u.owner_id = $1`,
      [ownerId],
    );
    const row = result.rows[0];
    return row ? toUser(row) : null;
  }

  async getUsers(ownerIds: readonly string[]): Promise<SchoolUser[]> {
    if (ownerIds.length === 0) return [];
    const result = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM school_users u WHERE u.owner_id = ANY($1::text[])`,
      [ownerIds],
    );
    return result.rows.map(toUser);
  }

  async listUsers(limit: number): Promise<{ users: SchoolUser[]; truncated: boolean }> {
    const result = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS}
         FROM school_users u
        ORDER BY u.created_at ASC, u.owner_id ASC
        LIMIT $1`,
      [limit + 1],
    );
    return {
      users: result.rows.slice(0, limit).map(toUser),
      truncated: result.rows.length > limit,
    };
  }

  async upsertProfile(input: {
    ownerId: string;
    displayName: string | null;
    email: string | null;
  }): Promise<SchoolUser> {
    await this.db.query(
      `INSERT INTO school_users (owner_id, display_name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_id) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, school_users.display_name),
             email = COALESCE(EXCLUDED.email, school_users.email),
             updated_at = now()`,
      [input.ownerId, input.displayName, input.email],
    );
    const user = await this.getUser(input.ownerId);
    if (!user) throw new Error('school user upsert did not return a row');
    return user;
  }

  async setRoles(
    ownerId: string,
    roles: readonly SchoolRole[],
    managed: boolean,
  ): Promise<SchoolUser> {
    const sorted = sortSchoolRoles(roles);
    await this.withTransaction(async (tx) => {
      await tx.query(`DELETE FROM school_role_bindings WHERE owner_id = $1`, [ownerId]);
      for (const role of sorted) {
        await tx.query(`INSERT INTO school_role_bindings (owner_id, role) VALUES ($1, $2)`, [
          ownerId,
          role,
        ]);
      }
      const updated = await tx.query<{ owner_id: string } & Record<string, unknown>>(
        `UPDATE school_users
            SET roles_managed = $2 OR roles_managed,
                updated_at = now()
          WHERE owner_id = $1
          RETURNING owner_id`,
        [ownerId, managed],
      );
      if (updated.rows.length === 0) {
        throw new Error(`school user ${ownerId} does not exist`);
      }
    });
    const user = await this.getUser(ownerId);
    if (!user) throw new Error(`school user ${ownerId} does not exist`);
    return user;
  }

  async syncFromLogin(input: {
    ownerId: string;
    displayName: string | null;
    email: string | null;
    claimedRoles: readonly SchoolRole[];
  }): Promise<SchoolRole[]> {
    const sorted = sortSchoolRoles(input.claimedRoles);
    return this.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO school_users (owner_id, display_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner_id) DO UPDATE
           SET display_name = COALESCE(EXCLUDED.display_name, school_users.display_name),
               email = COALESCE(EXCLUDED.email, school_users.email),
               updated_at = now()`,
        [input.ownerId, input.displayName, input.email],
      );
      const managed = await tx.query<{ roles_managed: boolean } & Record<string, unknown>>(
        `SELECT roles_managed FROM school_users WHERE owner_id = $1`,
        [input.ownerId],
      );
      if (managed.rows[0]?.roles_managed === true) {
        const roles = await tx.query<{ role: string } & Record<string, unknown>>(
          `SELECT role FROM school_role_bindings WHERE owner_id = $1`,
          [input.ownerId],
        );
        return sortSchoolRoles(roles.rows.map((row) => row.role).filter(isSchoolRole));
      }
      await tx.query(`DELETE FROM school_role_bindings WHERE owner_id = $1`, [input.ownerId]);
      for (const role of sorted) {
        await tx.query(`INSERT INTO school_role_bindings (owner_id, role) VALUES ($1, $2)`, [
          input.ownerId,
          role,
        ]);
      }
      return sorted;
    });
  }

  async createClass(input: { id: string; name: string; createdBy: string }): Promise<SchoolClass> {
    try {
      await this.db.query(`INSERT INTO school_classes (id, name, created_by) VALUES ($1, $2, $3)`, [
        input.id,
        input.name,
        input.createdBy,
      ]);
    } catch (error) {
      const info = pgError(error);
      if (info.code === '23505' && info.constraint === 'school_classes_live_name_idx') {
        throw new SchoolNameTakenError();
      }
      throw error;
    }
    const schoolClass = await this.getClass(input.id);
    if (!schoolClass) throw new Error('school class insert did not return a row');
    return schoolClass;
  }

  async getClass(id: string): Promise<SchoolClass | null> {
    const result = await this.db.query<ClassRow>(
      `SELECT ${CLASS_COLUMNS} FROM school_classes c WHERE c.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toClass(row) : null;
  }

  async listClasses(): Promise<SchoolClass[]> {
    const result = await this.db.query<ClassRow>(
      `SELECT ${CLASS_COLUMNS} FROM school_classes c ORDER BY c.created_at ASC, c.id ASC`,
    );
    return result.rows.map(toClass);
  }

  async archiveClass(id: string): Promise<SchoolClass | null> {
    await this.db.query(
      `UPDATE school_classes
          SET archived_at = COALESCE(archived_at, now())
        WHERE id = $1`,
      [id],
    );
    return this.getClass(id);
  }

  async addTeacher(classId: string, ownerId: string, assignedBy: string): Promise<SchoolClass> {
    await this.db.query(
      `INSERT INTO school_class_teachers (class_id, owner_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (class_id, owner_id) DO NOTHING`,
      [classId, ownerId, assignedBy],
    );
    return this.requireClass(classId);
  }

  async removeTeacher(classId: string, ownerId: string): Promise<SchoolClass> {
    await this.db.query(`DELETE FROM school_class_teachers WHERE class_id = $1 AND owner_id = $2`, [
      classId,
      ownerId,
    ]);
    return this.requireClass(classId);
  }

  async addMember(classId: string, ownerId: string, addedBy: string): Promise<SchoolClass> {
    await this.db.query(
      `INSERT INTO school_class_members (class_id, owner_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (class_id, owner_id) DO NOTHING`,
      [classId, ownerId, addedBy],
    );
    return this.requireClass(classId);
  }

  async removeMember(classId: string, ownerId: string): Promise<SchoolClass> {
    await this.db.query(`DELETE FROM school_class_members WHERE class_id = $1 AND owner_id = $2`, [
      classId,
      ownerId,
    ]);
    return this.requireClass(classId);
  }

  async assignCourseClass(stageId: string, classId: string, assignedBy: string): Promise<void> {
    await this.db.query(
      `INSERT INTO school_course_class_assignments (stage_id, class_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (stage_id, class_id) DO NOTHING`,
      [stageId, classId, assignedBy],
    );
  }

  async removeCourseClass(stageId: string, classId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM school_course_class_assignments WHERE stage_id = $1 AND class_id = $2`,
      [stageId, classId],
    );
  }

  async assignCourseStudents(
    stageId: string,
    ownerIds: readonly string[],
    assignedBy: string,
  ): Promise<void> {
    for (const ownerId of ownerIds) {
      await this.db.query(
        `INSERT INTO school_course_student_assignments (stage_id, owner_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (stage_id, owner_id) DO NOTHING`,
        [stageId, ownerId, assignedBy],
      );
    }
  }

  async removeCourseStudent(stageId: string, ownerId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM school_course_student_assignments WHERE stage_id = $1 AND owner_id = $2`,
      [stageId, ownerId],
    );
  }

  async getCourseAssignment(stageId: string): Promise<CourseAssignment> {
    const classes = await this.db.query<{ class_id: string } & Record<string, unknown>>(
      `SELECT class_id FROM school_course_class_assignments
        WHERE stage_id = $1
        ORDER BY assigned_at ASC, class_id ASC`,
      [stageId],
    );
    const students = await this.db.query<{ owner_id: string } & Record<string, unknown>>(
      `SELECT owner_id FROM school_course_student_assignments
        WHERE stage_id = $1
        ORDER BY assigned_at ASC, owner_id ASC`,
      [stageId],
    );
    return {
      classIds: classes.rows.map((row) => row.class_id),
      studentIds: students.rows.map((row) => row.owner_id),
    };
  }

  async assignmentMatch(stageId: string, ownerId: string): Promise<AssignmentMatch> {
    const result = await this.db.query<
      { class_assign: boolean; student_assign: boolean } & Record<string, unknown>
    >(
      `SELECT EXISTS (
         SELECT 1
           FROM school_course_class_assignments AS a
           JOIN school_class_members AS m
             ON m.class_id = a.class_id AND m.owner_id = $2
          WHERE a.stage_id = $1
       ) AS class_assign,
       EXISTS (
         SELECT 1
           FROM school_course_student_assignments AS s
          WHERE s.stage_id = $1 AND s.owner_id = $2
       ) AS student_assign`,
      [stageId, ownerId],
    );
    const row = result.rows[0];
    return {
      classAssign: row?.class_assign === true,
      studentAssign: row?.student_assign === true,
    };
  }

  async listLearnerAssignments(ownerId: string): Promise<LearnerAssignment[]> {
    const classes = await this.db.query<
      { stage_id: string; class_id: string } & Record<string, unknown>
    >(
      `SELECT a.stage_id, a.class_id
         FROM school_course_class_assignments AS a
         JOIN school_class_members AS m
           ON m.class_id = a.class_id AND m.owner_id = $1
        ORDER BY a.stage_id ASC, a.class_id ASC`,
      [ownerId],
    );
    const directs = await this.db.query<{ stage_id: string } & Record<string, unknown>>(
      `SELECT stage_id FROM school_course_student_assignments
        WHERE owner_id = $1
        ORDER BY stage_id ASC`,
      [ownerId],
    );
    const byStage = new Map<string, LearnerAssignment>();
    for (const row of classes.rows) {
      const existing = byStage.get(row.stage_id);
      if (existing) existing.classIds.push(row.class_id);
      else
        byStage.set(row.stage_id, {
          stageId: row.stage_id,
          classIds: [row.class_id],
          direct: false,
        });
    }
    for (const row of directs.rows) {
      const existing = byStage.get(row.stage_id);
      if (existing) existing.direct = true;
      else byStage.set(row.stage_id, { stageId: row.stage_id, classIds: [], direct: true });
    }
    return [...byStage.values()].sort((a, b) => (a.stageId < b.stageId ? -1 : 1));
  }

  private async requireClass(classId: string): Promise<SchoolClass> {
    const schoolClass = await this.getClass(classId);
    if (!schoolClass) throw new Error(`school class ${classId} does not exist`);
    return schoolClass;
  }
}

export async function createPgSchoolRepository(): Promise<SchoolRepository> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for school identity');
  }
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { pool } = await getServerPersistenceProvider(connectionString);
  const queryable = pool as unknown as Queryable & ConnectableQueryable;
  await ensureSchoolSchema(queryable);
  return new PgSchoolRepository(queryable);
}
