/**
 * Process-wide school directory. Tests inject a repository so route and auth
 * tests do not open PostgreSQL. Production builds the PostgreSQL repository
 * on first use, which also applies the school schema.
 */
import type { SchoolRepository } from './types';

let override: SchoolRepository | undefined;
let pending: Promise<SchoolRepository> | undefined;

export function setSchoolRepositoryForTests(repo: SchoolRepository | undefined): void {
  override = repo;
  pending = undefined;
}

export async function getSchoolRepository(): Promise<SchoolRepository> {
  if (override) return override;
  pending ??= create().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function create(): Promise<SchoolRepository> {
  const { createPgSchoolRepository } = await import('./pg-repository');
  return createPgSchoolRepository();
}
