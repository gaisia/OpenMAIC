/**
 * Quiz scenes a school submission grades against.
 *
 * Tests inject a bank. Production reads `document_scenes`, the same rows the
 * classroom loads. Only scenes whose content is a quiz are returned.
 */
import type { QuizQuestion } from '@/lib/types/stage';
import type { Queryable } from '@openmaic/storage/document/pg';

export interface SchoolQuizScene {
  sceneId: string;
  title: string;
  questions: QuizQuestion[];
}

export interface QuizBank {
  getScene(stageId: string, sceneId: string): Promise<SchoolQuizScene | null>;
  /** Quiz scenes in lesson order. */
  listScenes(stageId: string): Promise<SchoolQuizScene[]>;
}

let override: QuizBank | undefined;
let pending: Promise<QuizBank> | undefined;

export function setQuizBankForTests(bank: QuizBank | undefined): void {
  override = bank;
  pending = undefined;
}

export async function getQuizBank(): Promise<QuizBank> {
  if (override) return override;
  pending ??= create().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function create(): Promise<QuizBank> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for school quizzes');
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { pool } = await getServerPersistenceProvider(connectionString);
  return new PgQuizBank(pool as unknown as Queryable);
}

interface SceneRow extends Record<string, unknown> {
  id: string;
  data: unknown;
}

function isQuizQuestion(value: unknown): value is QuizQuestion {
  if (!value || typeof value !== 'object') return false;
  const question = value as QuizQuestion;
  return (
    typeof question.id === 'string' &&
    question.id.length > 0 &&
    (question.type === 'single' ||
      question.type === 'multiple' ||
      question.type === 'short_answer') &&
    typeof question.question === 'string'
  );
}

export function parseStoredQuizScene(sceneId: string, data: unknown): SchoolQuizScene | null {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const scene = value as { type?: unknown; title?: unknown; content?: unknown };
  const content = scene.content;
  if (!content || typeof content !== 'object') return null;
  const quiz = content as { type?: unknown; questions?: unknown };
  if (scene.type !== 'quiz' && quiz.type !== 'quiz') return null;
  if (!Array.isArray(quiz.questions)) return null;
  const questions = quiz.questions.filter(isQuizQuestion);
  if (questions.length === 0) return null;
  return {
    sceneId,
    title: typeof scene.title === 'string' ? scene.title : '',
    questions,
  };
}

export class PgQuizBank implements QuizBank {
  constructor(private readonly db: Queryable) {}

  async listScenes(stageId: string): Promise<SchoolQuizScene[]> {
    const result = await this.db.query<SceneRow>(
      `SELECT id, data
         FROM document_scenes
        WHERE stage_id = $1
        ORDER BY scene_order ASC, id ASC`,
      [stageId],
    );
    const scenes: SchoolQuizScene[] = [];
    for (const row of result.rows) {
      const scene = parseStoredQuizScene(row.id, row.data);
      if (scene) scenes.push(scene);
    }
    return scenes;
  }

  async getScene(stageId: string, sceneId: string): Promise<SchoolQuizScene | null> {
    const result = await this.db.query<SceneRow>(
      `SELECT id, data
         FROM document_scenes
        WHERE stage_id = $1 AND id = $2`,
      [stageId, sceneId],
    );
    const row = result.rows[0];
    return row ? parseStoredQuizScene(row.id, row.data) : null;
  }
}

/** In-memory bank for tests. Scenes are kept in insertion order. */
export class MemoryQuizBank implements QuizBank {
  private readonly scenes = new Map<string, SchoolQuizScene[]>();

  put(stageId: string, scene: SchoolQuizScene): void {
    const list = this.scenes.get(stageId) ?? [];
    const index = list.findIndex((item) => item.sceneId === scene.sceneId);
    if (index >= 0) list[index] = scene;
    else list.push(scene);
    this.scenes.set(stageId, list);
  }

  async getScene(stageId: string, sceneId: string): Promise<SchoolQuizScene | null> {
    return this.scenes.get(stageId)?.find((scene) => scene.sceneId === sceneId) ?? null;
  }

  async listScenes(stageId: string): Promise<SchoolQuizScene[]> {
    return [...(this.scenes.get(stageId) ?? [])];
  }
}
