/**
 * Move school directory rows when an anonymous owner is claimed into an
 * account. Registered from `registerSchoolHost`. A deployment that has not
 * created the tables yet is a no-op: schema migration refuses to run inside
 * the claim's transaction, so this only touches tables that already exist.
 *
 * Owner ids on profile, role, teacher, member, direct course-assignment, and
 * quiz-attempt rows follow `ON UPDATE CASCADE`. `assigned_by` is not a
 * foreign key, so it is rewritten here. When the account already has a
 * profile, the anonymous rows are merged and the source profile is deleted.
 * Quiz attempts are reassigned first so that delete does not cascade them away.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

async function tableReady(tx: Queryable): Promise<boolean> {
  const result = await tx.query<{ present: boolean } & Record<string, unknown>>(
    `SELECT to_regclass('school_users') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

async function assignmentsReady(tx: Queryable): Promise<boolean> {
  const result = await tx.query<{ present: boolean } & Record<string, unknown>>(
    `SELECT to_regclass('school_course_class_assignments') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

async function rewriteActors(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<number> {
  const classes = await tx.query(
    `UPDATE school_classes SET created_by = $2 WHERE created_by = $1 RETURNING 1`,
    [fromOwnerId, toOwnerId],
  );
  const teachers = await tx.query(
    `UPDATE school_class_teachers SET assigned_by = $2 WHERE assigned_by = $1 RETURNING 1`,
    [fromOwnerId, toOwnerId],
  );
  const members = await tx.query(
    `UPDATE school_class_members SET added_by = $2 WHERE added_by = $1 RETURNING 1`,
    [fromOwnerId, toOwnerId],
  );
  if (!(await assignmentsReady(tx))) {
    return classes.rows.length + teachers.rows.length + members.rows.length;
  }
  const classAssignments = await tx.query(
    `UPDATE school_course_class_assignments SET assigned_by = $2 WHERE assigned_by = $1 RETURNING 1`,
    [fromOwnerId, toOwnerId],
  );
  const studentAssignments = await tx.query(
    `UPDATE school_course_student_assignments SET assigned_by = $2 WHERE assigned_by = $1 RETURNING 1`,
    [fromOwnerId, toOwnerId],
  );
  return (
    classes.rows.length +
    teachers.rows.length +
    members.rows.length +
    classAssignments.rows.length +
    studentAssignments.rows.length
  );
}

async function quizAttemptsReady(tx: Queryable): Promise<boolean> {
  const result = await tx.query<{ present: boolean } & Record<string, unknown>>(
    `SELECT to_regclass('school_quiz_attempts') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

/** Keep submissions when two profiles merge. A plain owner-id update cascades instead. */
async function mergeQuizAttempts(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<void> {
  if (!(await quizAttemptsReady(tx))) return;
  await tx.query(`UPDATE school_quiz_attempts SET owner_id = $2 WHERE owner_id = $1`, [
    fromOwnerId,
    toOwnerId,
  ]);
}

/** Copy direct course assignments onto the account before the source profile is deleted. */
async function mergeStudentAssignments(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<void> {
  if (!(await assignmentsReady(tx))) return;
  await tx.query(
    `INSERT INTO school_course_student_assignments (stage_id, owner_id, assigned_by, assigned_at)
     SELECT stage_id, $2, assigned_by, assigned_at
       FROM school_course_student_assignments
      WHERE owner_id = $1
     ON CONFLICT DO NOTHING`,
    [fromOwnerId, toOwnerId],
  );
}

export async function rekeySchoolDirectory(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<number> {
  if (!(await tableReady(tx))) return 0;
  const source = await tx.query(`SELECT 1 FROM school_users WHERE owner_id = $1`, [fromOwnerId]);
  if (source.rows.length === 0) return rewriteActors(tx, fromOwnerId, toOwnerId);
  const target = await tx.query(`SELECT 1 FROM school_users WHERE owner_id = $1`, [toOwnerId]);
  if (target.rows.length === 0) {
    const moved = await tx.query(
      `UPDATE school_users SET owner_id = $2, updated_at = now() WHERE owner_id = $1 RETURNING 1`,
      [fromOwnerId, toOwnerId],
    );
    return moved.rows.length + (await rewriteActors(tx, fromOwnerId, toOwnerId));
  }
  await tx.query(
    `UPDATE school_users AS target
        SET roles_managed = target.roles_managed OR source.roles_managed,
            display_name = COALESCE(target.display_name, source.display_name),
            email = COALESCE(target.email, source.email),
            updated_at = now()
       FROM school_users AS source
      WHERE target.owner_id = $2
        AND source.owner_id = $1`,
    [fromOwnerId, toOwnerId],
  );
  await tx.query(
    `INSERT INTO school_role_bindings (owner_id, role)
     SELECT $2, role FROM school_role_bindings WHERE owner_id = $1
     ON CONFLICT DO NOTHING`,
    [fromOwnerId, toOwnerId],
  );
  await tx.query(
    `INSERT INTO school_class_teachers (class_id, owner_id, assigned_by, assigned_at)
     SELECT class_id, $2, assigned_by, assigned_at
       FROM school_class_teachers
      WHERE owner_id = $1
     ON CONFLICT DO NOTHING`,
    [fromOwnerId, toOwnerId],
  );
  await tx.query(
    `INSERT INTO school_class_members (class_id, owner_id, added_by, added_at)
     SELECT class_id, $2, added_by, added_at
       FROM school_class_members
      WHERE owner_id = $1
     ON CONFLICT DO NOTHING`,
    [fromOwnerId, toOwnerId],
  );
  await mergeStudentAssignments(tx, fromOwnerId, toOwnerId);
  await mergeQuizAttempts(tx, fromOwnerId, toOwnerId);
  const actors = await rewriteActors(tx, fromOwnerId, toOwnerId);
  const deleted = await tx.query(`DELETE FROM school_users WHERE owner_id = $1 RETURNING 1`, [
    fromOwnerId,
  ]);
  return actors + deleted.rows.length;
}
