/**
 * School directory tables: user profiles, global role bindings, classes,
 * teaching assignments, class membership, and course assignments.
 *
 * Provisioned lazily on the first school login or school API call
 * (`ensureSchoolSchema`), and listed in `APP_SCHEMA_STORES` so a database
 * upgraded by a newer release is refused at startup. Version 1 is the
 * directory baseline. Version 2 adds course↔class and course↔student
 * assignments. Both are idempotent statement by statement.
 *
 * Publication itself is not a school column. Publish writes the upstream
 * `stage_meta.is_public` / `published_at` pair (`course:publish`). Assignments
 * stay here and remain after unpublish, so a later publish restores them.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

export const SCHOOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS school_users (
  owner_id TEXT PRIMARY KEY,
  display_name TEXT,
  email TEXT,
  roles_managed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT school_users_owner_id_len CHECK (char_length(owner_id) BETWEEN 1 AND 256)
);

CREATE TABLE IF NOT EXISTS school_role_bindings (
  owner_id TEXT NOT NULL REFERENCES school_users (owner_id) ON DELETE CASCADE ON UPDATE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (owner_id, role),
  CONSTRAINT school_role_bindings_role_check CHECK (role IN ('admin', 'teacher', 'student'))
);

CREATE TABLE IF NOT EXISTS school_classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT school_classes_name_len CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX IF NOT EXISTS school_classes_live_name_idx
  ON school_classes (lower(name))
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS school_class_teachers (
  class_id TEXT NOT NULL REFERENCES school_classes (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES school_users (owner_id) ON DELETE CASCADE ON UPDATE CASCADE,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, owner_id)
);

CREATE INDEX IF NOT EXISTS school_class_teachers_owner_idx
  ON school_class_teachers (owner_id);

CREATE TABLE IF NOT EXISTS school_class_members (
  class_id TEXT NOT NULL REFERENCES school_classes (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES school_users (owner_id) ON DELETE CASCADE ON UPDATE CASCADE,
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, owner_id)
);

CREATE INDEX IF NOT EXISTS school_class_members_owner_idx
  ON school_class_members (owner_id);
`;

/**
 * Course assignments. A class row is membership-dynamic: a student who joins
 * the class later matches it without a new write. A student row is that one
 * person. Neither row requires the course to be published.
 */
export const SCHOOL_ASSIGNMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS school_course_class_assignments (
  stage_id TEXT NOT NULL,
  class_id TEXT NOT NULL REFERENCES school_classes (id) ON DELETE CASCADE,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, class_id),
  CONSTRAINT school_course_class_stage_len CHECK (char_length(stage_id) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS school_course_class_class_idx
  ON school_course_class_assignments (class_id);

CREATE TABLE IF NOT EXISTS school_course_student_assignments (
  stage_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES school_users (owner_id) ON DELETE CASCADE ON UPDATE CASCADE,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, owner_id),
  CONSTRAINT school_course_student_stage_len CHECK (char_length(stage_id) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS school_course_student_owner_idx
  ON school_course_student_assignments (owner_id);
`;

export const SCHOOL_MIGRATIONS: SchemaMigrationSet = {
  store: 'school-directory',
  migrations: [
    { version: 1, name: 'baseline', up: SCHOOL_SCHEMA, transaction: false },
    { version: 2, name: 'course_assignments', up: SCHOOL_ASSIGNMENT_SCHEMA, transaction: true },
  ],
};

export async function ensureSchoolSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, SCHOOL_MIGRATIONS);
}
