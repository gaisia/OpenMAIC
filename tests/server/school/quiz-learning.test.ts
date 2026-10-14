/**
 * US-QL-01 … US-QL-09 for quiz attempts, own results, and the class gradebook.
 *
 * PostgreSQL is not required. Publication is an in-memory stand-in for
 * `stage_meta`, the directory is the in-memory school repository, and the
 * quiz bank stands in for `document_scenes`. Short answers use a stub of the
 * `/api/quiz-grade` scorer.
 */
import type { QuizQuestion } from '@/lib/types/stage';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import { interpretShortAnswerGrade } from '@/lib/server/quiz-grade';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import { resetPersistenceHooksForTests } from '@/lib/server/persistence-hooks/registry';
import { MemoryCourseCatalog, setCourseCatalogForTests } from '@/lib/server/school/course-catalog';
import { SCHOOL_SHARE, schoolDocumentReadDenial } from '@/lib/server/school/courses';
import { MemorySchoolRepository } from '@/lib/server/school/memory-repository';
import { MemoryQuizBank, setQuizBankForTests } from '@/lib/server/school/quiz-bank';
import {
  getClassGradebook,
  getQuizAttempt,
  getQuizResults,
  postQuizSubmit,
  setShortAnswerGraderForTests,
} from '@/lib/server/school/quiz-handlers';
import { registerSchoolHost } from '@/lib/server/school/register';
import { setSchoolRepositoryForTests } from '@/lib/server/school/repository';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';

const SECRET = 'test-secret-test-secret-test-secret';
const ISSUER = 'https://school.example/';
const AUDIENCE = 'openmaic';
const STAGE = 'stage-c';
const SCENE = 'scene-quiz';

let repo: MemorySchoolRepository;
let catalog: MemoryCourseCatalog;
let bank: MemoryQuizBank;
const shortAnswer = vi.fn(async () => ({ score: 0, comment: 'unused' }));

function choice(id: string, answer: string, points = 1): QuizQuestion {
  return {
    id,
    type: 'single',
    question: id,
    options: [
      { label: 'yes', value: 'A' },
      { label: 'no', value: 'B' },
    ],
    answer: [answer],
    points,
  };
}

async function sign(sub: string, roles: string[]): Promise<string> {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(SECRET));
}

function request(
  path: string,
  token?: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(new URL(path, 'http://school.local'), {
    method,
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

interface AttemptBody {
  attemptId: string;
  ownerId: string;
  source: string;
  status: string;
  result: {
    totalScore: number;
    totalPoints: number;
    grader: string;
    perQuestion: {
      questionId: string;
      earned: number;
      maxPoints: number;
      correct: boolean | null;
      comment?: string;
    }[];
  } | null;
}

interface GradebookBody {
  gradebook: {
    published: boolean;
    scenes: {
      sceneId: string;
      rosterCount: number;
      submittedCount: number;
      submissionRate: number | null;
      averageScore: number | null;
      questions: {
        questionId: string;
        accuracy: number | null;
        scoreRate: number | null;
        correctCount: number;
        submittedCount: number;
      }[];
      students: {
        ownerId: string;
        submitted: boolean;
        score: number | null;
        submittedAt: string | null;
      }[];
    }[];
  };
}

async function bodyOf(response: Response): Promise<{
  error?: { code: string };
  attempt?: AttemptBody;
  results?: AttemptBody[];
  history?: AttemptBody[];
  gradebook?: GradebookBody['gradebook'];
}> {
  return response.json() as Promise<ReturnType<typeof bodyOf>>;
}

beforeEach(() => {
  vi.stubEnv('SCHOOL_JWT_ISSUER', ISSUER);
  vi.stubEnv('SCHOOL_JWT_AUDIENCE', AUDIENCE);
  vi.stubEnv('SCHOOL_JWT_SECRET', SECRET);
  vi.stubEnv('OWNER_SINGLE_USER', 'false');
  vi.stubEnv('OWNER_ANONYMOUS_PREMINT', 'false');
  vi.stubEnv('DATABASE_URL', 'postgres://openmaic:openmaic@127.0.0.1:5432/openmaic');
  vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
  vi.stubEnv('OWNER_SINGLE_USER_ID', '');
  repo = new MemorySchoolRepository();
  catalog = new MemoryCourseCatalog();
  bank = new MemoryQuizBank();
  bank.put(STAGE, {
    sceneId: SCENE,
    title: 'Quiz',
    questions: [choice('q1', 'A', 1), choice('q2', 'B', 1)],
  });
  shortAnswer.mockReset();
  shortAnswer.mockImplementation(async () => {
    throw new Error('unexpected short-answer grade');
  });
  setSchoolRepositoryForTests(repo);
  setCourseCatalogForTests(catalog);
  setQuizBankForTests(bank);
  setShortAnswerGraderForTests(shortAnswer);
  registerSchoolHost();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
  resetPersistenceHooksForTests();
  resetClaimParticipantsForTests();
  setSchoolRepositoryForTests(undefined);
  setCourseCatalogForTests(undefined);
  setQuizBankForTests(undefined);
  setShortAnswerGraderForTests(undefined);
});

async function seed(): Promise<{
  teacher: string;
  bea: string;
  dee: string;
  eve: string;
  admin: string;
  other: string;
}> {
  await repo.syncFromLogin({
    ownerId: 'user:ada',
    displayName: 'Ada',
    email: null,
    claimedRoles: ['admin'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:ted',
    displayName: 'Ted',
    email: null,
    claimedRoles: ['teacher'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:otto',
    displayName: 'Otto',
    email: null,
    claimedRoles: ['teacher'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:bea',
    displayName: 'Bea',
    email: null,
    claimedRoles: ['student'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:dee',
    displayName: 'Dee',
    email: null,
    claimedRoles: ['student'],
  });
  await repo.syncFromLogin({
    ownerId: 'user:eve',
    displayName: 'Eve',
    email: null,
    claimedRoles: ['student'],
  });
  await repo.createClass({ id: 'cls_1', name: 'Class-1', createdBy: 'user:ada' });
  await repo.addTeacher('cls_1', 'user:ted', 'user:ada');
  await repo.addMember('cls_1', 'user:bea', 'user:ted');
  await repo.addMember('cls_1', 'user:dee', 'user:ted');
  catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: 1_700_000_000_000 });
  await repo.assignCourseClass(STAGE, 'cls_1', 'user:ted');
  return {
    teacher: await sign('ted', ['school:teacher']),
    bea: await sign('bea', ['school:student']),
    dee: await sign('dee', ['school:student']),
    eve: await sign('eve', ['school:student']),
    admin: await sign('ada', ['school:admin']),
    other: await sign('otto', ['school:teacher']),
  };
}

function submit(
  token: string | undefined,
  answers: Record<string, string | string[]>,
  extra?: object,
) {
  return postQuizSubmit(
    request(`/api/school/courses/${STAGE}/quizzes/${SCENE}/submit`, token, {
      body: { answers, ...extra },
    }),
    STAGE,
    SCENE,
  );
}

function gradebook(token: string, classId = 'cls_1') {
  return getClassGradebook(
    request(`/api/school/courses/${STAGE}/gradebook?classId=${classId}`, token),
    STAGE,
  );
}

describe('school quiz learning', () => {
  it('parses short-answer grades the same way /api/quiz-grade does', () => {
    expect(interpretShortAnswerGrade('{"score": 2, "comment": "good"}', 2)).toEqual({
      score: 2,
      comment: 'good',
    });
    expect(interpretShortAnswerGrade('not json', 4).score).toBe(2);
    expect(interpretShortAnswerGrade('{"score": 9}', 2).score).toBe(2);
  });

  it('US-QL-01 an assigned student submit is stored, and unsigned or unreadable submits are refused', async () => {
    const { bea } = await seed();
    const missing = await submit(undefined, { q1: 'A', q2: 'B' });
    expect(missing.status).toBe(401);
    expect((await bodyOf(missing)).error?.code).toBe('INVALID_CREDENTIAL');

    catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: null });
    const draft = await submit(bea, { q1: 'A', q2: 'B' });
    expect(draft.status).toBe(403);
    expect((await bodyOf(draft)).error?.code).toBe('COURSE_NOT_READABLE');

    catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: 1_700_000_000_000 });
    await repo.removeCourseClass(STAGE, 'cls_1');
    const unassigned = await submit(bea, { q1: 'A', q2: 'B' });
    expect(unassigned.status).toBe(403);

    await repo.assignCourseClass(STAGE, 'cls_1', 'user:ted');
    const submitted = await submit(bea, { q1: 'A', q2: 'B' }, { totalScore: 100 });
    expect(submitted.status).toBe(200);
    const attempt = (await bodyOf(submitted)).attempt;
    expect(attempt).toMatchObject({
      ownerId: 'user:bea',
      source: 'student',
      status: 'graded',
      result: { totalScore: 2, totalPoints: 2, grader: 'local' },
    });
    expect(attempt?.result?.totalScore).toBe(2);
    const stored = await repo.getQuizAttempt(attempt!.attemptId);
    expect(stored?.result?.totalScore).toBe(2);
  });

  it('US-QL-02 a student sees only their own results and cannot open the gradebook', async () => {
    const { bea, dee } = await seed();
    const beaSubmit = await submit(bea, { q1: 'A', q2: 'B' });
    const deeSubmit = await submit(dee, { q1: 'A', q2: 'A' });
    const beaId = (await bodyOf(beaSubmit)).attempt!.attemptId;
    const deeId = (await bodyOf(deeSubmit)).attempt!.attemptId;

    const own = await getQuizResults(request('/api/school/quiz/results', bea));
    expect(own.status).toBe(200);
    const ownBody = await bodyOf(own);
    expect(ownBody.results?.map((item) => item.ownerId)).toEqual(['user:bea']);
    expect(ownBody.results?.[0]?.result?.totalScore).toBe(2);

    const other = await getQuizAttempt(request(`/api/school/quiz/attempts/${deeId}`, bea), deeId);
    expect(other.status).toBe(403);
    expect((await bodyOf(other)).error?.code).toBe('ATTEMPT_FORBIDDEN');

    const byQuery = await getQuizResults(
      request('/api/school/quiz/results?ownerId=user%3Adee', bea),
    );
    expect(byQuery.status).toBe(403);

    const book = await gradebook(bea);
    expect(book.status).toBe(403);

    const self = await getQuizAttempt(request(`/api/school/quiz/attempts/${beaId}`, bea), beaId);
    expect(self.status).toBe(200);
    expect((await bodyOf(self)).attempt?.result?.totalScore).toBe(2);
  });

  it('US-QL-03 and US-QL-04 the class teacher sees submit state, rate, average, and per-question accuracy', async () => {
    const { teacher, bea, dee, other } = await seed();
    await submit(bea, { q1: 'A', q2: 'B' });
    await submit(dee, { q1: 'A', q2: 'A' });

    const refused = await gradebook(other);
    expect(refused.status).toBe(403);

    const book = await gradebook(teacher);
    expect(book.status).toBe(200);
    const scene = (await bodyOf(book)).gradebook!.scenes[0]!;
    expect(scene.rosterCount).toBe(2);
    expect(scene.submittedCount).toBe(2);
    expect(scene.submissionRate).toBe(1);
    expect(scene.averageScore).toBe(1.5);
    expect(scene.students).toEqual([
      expect.objectContaining({ ownerId: 'user:bea', submitted: true, score: 2 }),
      expect.objectContaining({ ownerId: 'user:dee', submitted: true, score: 1 }),
    ]);
    expect(scene.questions).toEqual([
      expect.objectContaining({
        questionId: 'q1',
        correctCount: 2,
        submittedCount: 2,
        accuracy: 1,
        scoreRate: 1,
      }),
      expect.objectContaining({
        questionId: 'q2',
        correctCount: 1,
        submittedCount: 2,
        accuracy: 0.5,
        scoreRate: 0.5,
      }),
    ]);

    await repo.removeMember('cls_1', 'user:dee');
    const after = (await bodyOf(await gradebook(teacher))).gradebook!.scenes[0]!;
    expect(after.students.map((student) => student.ownerId)).toEqual(['user:bea']);
    expect(after.submissionRate).toBe(1);
  });

  it('US-QL-05 a direct assignment is in the class roster and an unassigned classmate is not', async () => {
    const { teacher, bea } = await seed();
    await repo.removeCourseClass(STAGE, 'cls_1');
    await repo.assignCourseStudents(STAGE, ['user:bea'], 'user:ted');
    await submit(bea, { q1: 'A', q2: 'B' });
    const scene = (await bodyOf(await gradebook(teacher))).gradebook!.scenes[0]!;
    expect(scene.students.map((student) => student.ownerId)).toEqual(['user:bea']);
    expect(scene.submittedCount).toBe(1);
    expect(scene.rosterCount).toBe(1);
  });

  it('US-QL-06 a student who joins the class later can submit and appears on the gradebook', async () => {
    const { teacher, eve } = await seed();
    const before = await submit(eve, { q1: 'A', q2: 'B' });
    expect(before.status).toBe(403);
    await repo.addMember('cls_1', 'user:eve', 'user:ted');
    const submitted = await submit(eve, { q1: 'A', q2: 'A' });
    expect(submitted.status).toBe(200);
    const scene = (await bodyOf(await gradebook(teacher))).gradebook!.scenes[0]!;
    expect(scene.students.map((student) => student.ownerId)).toEqual([
      'user:bea',
      'user:dee',
      'user:eve',
    ]);
    expect(scene.students.find((student) => student.ownerId === 'user:eve')).toMatchObject({
      submitted: true,
      score: 1,
    });
    expect(scene.submissionRate).toBeCloseTo(1 / 3);
  });

  it('US-QL-07 unpublish and unassign block a new submit but leave own history readable', async () => {
    const { teacher, bea } = await seed();
    const first = await submit(bea, { q1: 'A', q2: 'B' });
    const attemptId = (await bodyOf(first)).attempt!.attemptId;
    catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: null });
    const again = await submit(bea, { q1: 'B', q2: 'A' });
    expect(again.status).toBe(403);
    expect((await bodyOf(again)).error?.code).toBe('COURSE_NOT_READABLE');

    const own = await getQuizResults(request(`/api/school/quiz/results?stageId=${STAGE}`, bea));
    expect(own.status).toBe(200);
    expect((await bodyOf(own)).results?.[0]).toMatchObject({
      attemptId,
      result: { totalScore: 2 },
    });
    const byId = await getQuizAttempt(
      request(`/api/school/quiz/attempts/${attemptId}`, bea),
      attemptId,
    );
    expect(byId.status).toBe(200);

    catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: 1_700_000_000_000 });
    await repo.removeCourseClass(STAGE, 'cls_1');
    const lost = await submit(bea, { q1: 'A', q2: 'B' });
    expect(lost.status).toBe(403);
    const still = await getQuizAttempt(
      request(`/api/school/quiz/attempts/${attemptId}`, bea),
      attemptId,
    );
    expect((await bodyOf(still)).attempt?.result?.totalScore).toBe(2);
    const empty = (await bodyOf(await gradebook(teacher))).gradebook!.scenes[0]!;
    expect(empty.students).toEqual([]);
  });

  it('US-QL-08 a teacher self-test is graded and excluded from the class gradebook', async () => {
    const { teacher, bea } = await seed();
    catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: null });
    const self = await submit(teacher, { q1: 'A', q2: 'B' });
    expect(self.status).toBe(200);
    expect((await bodyOf(self)).attempt).toMatchObject({
      ownerId: 'user:ted',
      source: 'teacher_self',
      result: { totalScore: 2 },
    });

    catalog.put({ stageId: STAGE, ownerId: 'user:ted', name: 'C', publishedAt: 1_700_000_000_000 });
    await submit(bea, { q1: 'A', q2: 'A' });
    await repo.insertQuizAttempt({
      id: 'qat_self_bea',
      ownerId: 'user:bea',
      stageId: STAGE,
      sceneId: SCENE,
      answers: { q1: 'A', q2: 'B' },
      status: 'graded',
      source: 'teacher_self',
      result: {
        perQuestion: [],
        totalScore: 99,
        totalPoints: 2,
        grader: 'local',
      },
    });
    const scene = (await bodyOf(await gradebook(teacher))).gradebook!.scenes[0]!;
    expect(scene.students.map((student) => student.ownerId)).toEqual(['user:bea', 'user:dee']);
    expect(scene.students.find((student) => student.ownerId === 'user:bea')?.score).toBe(1);
    expect(scene.students.some((student) => student.ownerId === 'user:ted')).toBe(false);
  });

  it('US-QL-09 an unassigned stage link cannot submit, and public share stays off', async () => {
    const { eve } = await seed();
    expect(SCHOOL_SHARE.publicLink).toBe('disabled');
    const resolved = await resolveRequestOwner(request(`/api/persistence/documents/${STAGE}`, eve));
    if (!resolved.ok) throw new Error('expected a signed-in principal');
    const denied = await schoolDocumentReadDenial(resolved.principal, STAGE);
    expect(denied?.status).toBe(403);
    const submitted = await submit(eve, { q1: 'A', q2: 'B' });
    expect(submitted.status).toBe(403);
    expect((await bodyOf(submitted)).error?.code).toBe('COURSE_NOT_READABLE');
  });

  it('keeps every retake and shows the latest score to the student and the gradebook', async () => {
    const { teacher, bea, admin } = await seed();
    const first = await submit(bea, { q1: 'A', q2: 'B' });
    const firstId = (await bodyOf(first)).attempt!.attemptId;
    const second = await submit(bea, { q1: 'B', q2: 'A' });
    expect((await bodyOf(second)).attempt?.result?.totalScore).toBe(0);
    const listed = await getQuizResults(
      request(`/api/school/quiz/results?stageId=${STAGE}&sceneId=${SCENE}&history=1`, bea),
    );
    const listedBody = await bodyOf(listed);
    expect(listedBody.results?.[0]?.result?.totalScore).toBe(0);
    expect(listedBody.history?.map((item) => item.result?.totalScore)).toEqual([0, 2]);
    const original = await getQuizAttempt(
      request(`/api/school/quiz/attempts/${firstId}`, admin),
      firstId,
    );
    expect((await bodyOf(original)).attempt?.result?.totalScore).toBe(2);
    const scene = (await bodyOf(await gradebook(teacher))).gradebook!.scenes[0]!;
    expect(scene.students.find((student) => student.ownerId === 'user:bea')?.score).toBe(0);
    expect(scene.averageScore).toBe(0);
    expect(scene.submissionRate).toBe(0.5);
  });

  it('grades short answers through the quiz-grade stub and records a mixed grader', async () => {
    const { bea } = await seed();
    bank.put(STAGE, {
      sceneId: 'scene-short',
      title: 'Short',
      questions: [
        choice('q1', 'A', 1),
        {
          id: 's1',
          type: 'short_answer',
          question: 'why',
          points: 2,
          commentPrompt: 'mention gravity',
        },
      ],
    });
    shortAnswer.mockResolvedValue({ score: 2, comment: 'good' });
    const response = await postQuizSubmit(
      request(`/api/school/courses/${STAGE}/quizzes/scene-short/submit`, bea, {
        body: { answers: { q1: 'A', s1: 'because gravity' }, language: 'zh-CN' },
      }),
      STAGE,
      'scene-short',
    );
    expect(response.status).toBe(200);
    const attempt = (await bodyOf(response)).attempt;
    expect(attempt?.result).toMatchObject({
      grader: 'mixed',
      totalScore: 3,
      totalPoints: 3,
    });
    expect(attempt?.result?.perQuestion.find((item) => item.questionId === 's1')).toMatchObject({
      earned: 2,
      correct: true,
      comment: 'good',
    });
    expect(shortAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'why',
        userAnswer: 'because gravity',
        points: 2,
        commentPrompt: 'mention gravity',
        language: 'zh-CN',
      }),
    );
  });
});
