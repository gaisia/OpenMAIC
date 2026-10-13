/**
 * School directory tables: user profiles, global role bindings, classes,
 * teaching assignments, and class membership.
 *
 * Provisioned lazily on the first school login or school API call
 * (`ensureSchoolSchema`), and listed in `APP_SCHEMA_STORES` so a database
 * upgraded by a newer release is refused at startup. Version 1 is the
 * baseline and is idempotent statement by statement.
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

export const SCHOOL_MIGRATIONS: SchemaMigrationSet = {
  store: 'school-directory',
  migrations: [{ version: 1, name: 'baseline', up: SCHOOL_SCHEMA, transaction: false }],
};

export async function ensureSchoolSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, SCHOOL_MIGRATIONS);
}
