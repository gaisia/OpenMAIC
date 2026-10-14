/**
 * Live courses as the school layer needs them: owner, name, and the upstream
 * publication pair (`stage_meta.is_public` / `published_at`).
 *
 * Tests inject a catalog. Production reads and writes `stage_meta`, which is
 * the same row `POST /api/stages/:id/publish` updates.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { CourseSnapshot } from './can-read';

export interface CourseCatalog {
  get(stageId: string): Promise<CourseSnapshot | null>;
  getMany(stageIds: readonly string[]): Promise<CourseSnapshot[]>;
  /**
   * Set or clear publication. `publishedAt` null unpublishes. Returns null
   * when the course is missing or tombstoned. Does not touch assignments.
   */
  setPublished(stageId: string, publishedAt: number | null): Promise<CourseSnapshot | null>;
}

let override: CourseCatalog | undefined;
let pending: Promise<CourseCatalog> | undefined;

export function setCourseCatalogForTests(catalog: CourseCatalog | undefined): void {
  override = catalog;
  pending = undefined;
}

export async function getCourseCatalog(): Promise<CourseCatalog> {
  if (override) return override;
  pending ??= create().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function create(): Promise<CourseCatalog> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for school courses');
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { pool } = await getServerPersistenceProvider(connectionString);
  return new PgCourseCatalog(pool as unknown as Queryable);
}

interface CatalogRow extends Record<string, unknown> {
  stage_id: string;
  owner_id: string;
  name: string;
  is_public: boolean;
  published_at: number | string | null;
}

const CATALOG_SQL = `
  SELECT m.stage_id, m.owner_id, d.name, m.is_public, m.published_at
    FROM stage_meta AS m
    JOIN document_stages AS d ON d.id = m.stage_id
   WHERE m.deleted_at IS NULL
`;

function epoch(value: number | string | null, isPublic: boolean): number | null {
  if (!isPublic || value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSnapshot(row: CatalogRow): CourseSnapshot {
  return {
    stageId: row.stage_id,
    ownerId: row.owner_id,
    name: row.name,
    publishedAt: epoch(row.published_at, row.is_public === true),
  };
}

export class PgCourseCatalog implements CourseCatalog {
  constructor(private readonly db: Queryable) {}

  async get(stageId: string): Promise<CourseSnapshot | null> {
    const result = await this.db.query<CatalogRow>(`${CATALOG_SQL} AND m.stage_id = $1`, [stageId]);
    const row = result.rows[0];
    return row ? toSnapshot(row) : null;
  }

  async getMany(stageIds: readonly string[]): Promise<CourseSnapshot[]> {
    if (stageIds.length === 0) return [];
    const result = await this.db.query<CatalogRow>(
      `${CATALOG_SQL} AND m.stage_id = ANY($1::text[])`,
      [[...stageIds]],
    );
    const byId = new Map(result.rows.map((row) => [row.stage_id, toSnapshot(row)]));
    const courses: CourseSnapshot[] = [];
    for (const stageId of stageIds) {
      const course = byId.get(stageId);
      if (course) courses.push(course);
    }
    return courses;
  }

  async setPublished(stageId: string, publishedAt: number | null): Promise<CourseSnapshot | null> {
    await this.db.query(
      `UPDATE stage_meta
          SET is_public = $2, published_at = $3
        WHERE stage_id = $1 AND deleted_at IS NULL`,
      [stageId, publishedAt !== null, publishedAt],
    );
    return this.get(stageId);
  }
}

/** In-memory catalog for tests. A missing id is a missing course. */
export class MemoryCourseCatalog implements CourseCatalog {
  private readonly courses = new Map<string, CourseSnapshot>();

  put(course: CourseSnapshot): void {
    this.courses.set(course.stageId, { ...course });
  }

  async get(stageId: string): Promise<CourseSnapshot | null> {
    const course = this.courses.get(stageId);
    return course ? { ...course } : null;
  }

  async getMany(stageIds: readonly string[]): Promise<CourseSnapshot[]> {
    const courses: CourseSnapshot[] = [];
    for (const stageId of stageIds) {
      const course = await this.get(stageId);
      if (course) courses.push(course);
    }
    return courses;
  }

  async setPublished(stageId: string, publishedAt: number | null): Promise<CourseSnapshot | null> {
    const course = this.courses.get(stageId);
    if (!course) return null;
    course.publishedAt = publishedAt;
    return { ...course };
  }
}
