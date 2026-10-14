/**
 * School quiz attempts, the learner's own results, and the class gradebook.
 *
 * A student may submit only while `canRead` holds. The course owner may
 * self-test; that attempt is stored as `teacher_self` and left out of the
 * gradebook. Scores come from the upstream graders: choice questions locally,
 * short answers through the same prompt as `POST /api/quiz-grade`. There is
 * no path that writes a score the grader did not produce.
 *
 * Retakes insert a new attempt. The gradebook and the default own-results
 * view use the latest graded student attempt. Unpublish blocks a new submit
 * and does not hide attempts the learner already has.
 */
import { randomBytes } from 'node:crypto';

import type { QuizQuestion } from '@/lib/types/stage';
import { gradeChoiceQuestions, isShortAnswer } from '@/lib/quiz/grading';
import type { OwnerPrincipal } from '@/lib/server/identity';
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';

import { assertClassTeacher } from './authz';
import { canRead } from './can-read';
import type { CourseCatalog } from './course-catalog';
import { SchoolError } from './errors';
import { parseStageId } from './courses';
import type { QuizBank, SchoolQuizScene } from './quiz-bank';
import { hasSchoolRole, schoolRolesFromPrincipal } from './roles';
import type {
  QuizAnswers,
  QuizAttemptRecord,
  QuizAttemptSource,
  QuizGrader,
  QuizQuestionScore,
  SchoolClass,
  SchoolRepository,
  SchoolUser,
} from './types';

const ID_MAX = 256;
const MAX_ANSWER_KEYS = 200;
const MAX_ANSWER_CHARS = 20_000;
const MAX_MULTI_SELECT = 50;

/** Passed by the HTTP layer. Production calls `gradeShortAnswerFromRequest`. */
export type ShortAnswerGrader = (input: {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}) => Promise<{ score: number; comment: string }>;

export interface PublicQuestionScore {
  questionId: string;
  earned: number;
  maxPoints: number;
  correct: boolean | null;
  comment?: string;
}

export interface PublicQuizResult {
  perQuestion: PublicQuestionScore[];
  totalScore: number;
  totalPoints: number;
  gradedAt: string;
  grader: QuizGrader;
}

export interface PublicAttempt {
  attemptId: string;
  stageId: string;
  sceneId: string;
  ownerId: string;
  submittedAt: string;
  status: QuizAttemptRecord['status'];
  source: QuizAttemptSource;
  answers: QuizAnswers;
  result: PublicQuizResult | null;
}

export interface OwnResults {
  results: PublicAttempt[];
  history?: PublicAttempt[];
}

export interface GradebookStudent {
  ownerId: string;
  displayName: string | null;
  submitted: boolean;
  score: number | null;
  totalPoints: number | null;
  submittedAt: string | null;
  attemptId: string | null;
}

export interface GradebookQuestion {
  questionId: string;
  maxPoints: number;
  submittedCount: number;
  correctCount: number;
  /** Correct submissions divided by submissions that included this question. */
  accuracy: number | null;
  /** Sum of earned points divided by sum of max points, among those submissions. */
  scoreRate: number | null;
}

export interface GradebookScene {
  sceneId: string;
  title: string;
  rosterCount: number;
  submittedCount: number;
  submissionRate: number | null;
  averageScore: number | null;
  questions: GradebookQuestion[];
  students: GradebookStudent[];
}

export interface ClassGradebook {
  stageId: string;
  classId: string;
  published: boolean;
  scenes: GradebookScene[];
}

function newAttemptId(): string {
  return `qat_${randomBytes(8).toString('hex')}`;
}

function parseId(value: string, code: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > ID_MAX ||
    value.includes('\u0000') ||
    /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new SchoolError(400, code, `${label} is not usable`);
  }
  return value;
}

function assertSignedIn(principal: OwnerPrincipal): void {
  if (principal.kind === 'anonymous') {
    throw new SchoolError(401, 'NOT_AUTHENTICATED', 'sign in to use quiz results');
  }
}

function pointsOf(question: QuizQuestion): number {
  const points = question.points ?? 1;
  return Number.isFinite(points) && points > 0 ? points : 1;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function toPublic(attempt: QuizAttemptRecord): PublicAttempt {
  return {
    attemptId: attempt.id,
    stageId: attempt.stageId,
    sceneId: attempt.sceneId,
    ownerId: attempt.ownerId,
    submittedAt: attempt.submittedAt,
    status: attempt.status,
    source: attempt.source,
    answers: attempt.answers,
    result: attempt.result
      ? {
          perQuestion: attempt.result.perQuestion.map((item) => ({ ...item })),
          totalScore: attempt.result.totalScore,
          totalPoints: attempt.result.totalPoints,
          gradedAt: attempt.result.gradedAt,
          grader: attempt.result.grader,
        }
      : null,
  };
}

function parseAnswers(value: unknown): QuizAnswers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchoolError(400, 'INVALID_ANSWERS', 'answers must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ANSWER_KEYS) {
    throw new SchoolError(400, 'INVALID_ANSWERS', 'too many answers');
  }
  const answers: QuizAnswers = {};
  for (const [key, answer] of entries) {
    if (typeof answer === 'string') {
      if (answer.length > MAX_ANSWER_CHARS) {
        throw new SchoolError(400, 'INVALID_ANSWERS', 'an answer is too long');
      }
      answers[key] = answer;
    } else if (
      Array.isArray(answer) &&
      answer.length <= MAX_MULTI_SELECT &&
      answer.every((item) => typeof item === 'string' && item.length <= MAX_ANSWER_CHARS)
    ) {
      answers[key] = [...answer];
    } else {
      throw new SchoolError(
        400,
        'INVALID_ANSWERS',
        'each answer must be a string or an array of strings',
      );
    }
  }
  return answers;
}

function languageOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const language = (body as { language?: unknown }).language;
  return typeof language === 'string' && language.length > 0 && language.length <= 32
    ? language
    : undefined;
}

/**
 * Students submit only with `canRead`. Anyone else is a candidate self-test;
 * {@link assertOwnerSelfTest} then requires course ownership.
 */
async function submissionSource(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  stageId: string,
  published: boolean,
): Promise<QuizAttemptSource> {
  assertSignedIn(principal);
  const roles = schoolRolesFromPrincipal(principal);
  if (roles.includes('student')) {
    const match = await repo.assignmentMatch(stageId, principal.ownerId);
    if (
      !canRead({
        authenticated: true,
        published,
        classAssign: match.classAssign,
        studentAssign: match.studentAssign,
      })
    ) {
      throw new SchoolError(403, 'COURSE_NOT_READABLE', '无权学习该课程或课程未开放');
    }
    return 'student';
  }
  return 'teacher_self';
}

function assertOwnerSelfTest(
  principal: OwnerPrincipal,
  courseOwnerId: string,
  source: QuizAttemptSource,
): QuizAttemptSource {
  if (source === 'student') return source;
  const roles = schoolRolesFromPrincipal(principal);
  if (
    courseOwnerId === principal.ownerId &&
    (roles.includes('teacher') || roles.includes('admin'))
  ) {
    return 'teacher_self';
  }
  throw new SchoolError(
    403,
    'ROLE_REQUIRED',
    'only an assigned student, or the course owner, can submit',
  );
}

function shortAnswerText(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.join('\n').trim();
  return '';
}

function graderOf(usedLocal: boolean, usedLlm: boolean): QuizGrader {
  if (usedLocal && usedLlm) return 'mixed';
  if (usedLlm) return 'llm';
  return 'local';
}

async function gradeScene(
  scene: SchoolQuizScene,
  answers: QuizAnswers,
  language: string | undefined,
  gradeShortAnswer: ShortAnswerGrader,
): Promise<{ perQuestion: QuizQuestionScore[]; grader: QuizGrader }> {
  const choiceResults = gradeChoiceQuestions(scene.questions, answers);
  const choiceById = new Map(choiceResults.map((item) => [item.questionId, item]));
  let usedLlm = false;
  const perQuestion: QuizQuestionScore[] = [];
  for (const question of scene.questions) {
    const maxPoints = pointsOf(question);
    if (!isShortAnswer(question)) {
      const graded = choiceById.get(question.id);
      perQuestion.push({
        questionId: question.id,
        earned: graded?.earned ?? 0,
        maxPoints,
        correct: graded?.correct ?? false,
      });
      continue;
    }
    const text = shortAnswerText(answers[question.id]);
    if (!text) {
      perQuestion.push({ questionId: question.id, earned: 0, maxPoints, correct: false });
      continue;
    }
    let graded: { score: number; comment: string };
    try {
      graded = await gradeShortAnswer({
        question: question.question,
        userAnswer: text,
        points: maxPoints,
        commentPrompt: question.commentPrompt,
        language,
      });
    } catch (error) {
      if (error instanceof ModelAuthorizationError) {
        throw new SchoolError(error.httpStatus, error.code, error.message);
      }
      if (error instanceof SchoolError) throw error;
      throw new SchoolError(502, 'GRADING_FAILED', 'quiz grading failed');
    }
    usedLlm = true;
    const earned = Number.isFinite(graded.score)
      ? Math.max(0, Math.min(maxPoints, graded.score))
      : 0;
    const score: QuizQuestionScore = {
      questionId: question.id,
      earned,
      maxPoints,
      correct: earned >= maxPoints * 0.8,
    };
    if (graded.comment) score.comment = graded.comment;
    perQuestion.push(score);
  }
  const usedLocal = scene.questions.some((question) => !isShortAnswer(question));
  return { perQuestion, grader: graderOf(usedLocal, usedLlm) };
}

export async function submitQuiz(input: {
  repo: SchoolRepository;
  catalog: CourseCatalog;
  bank: QuizBank;
  principal: OwnerPrincipal;
  stageId: string;
  sceneId: string;
  body: unknown;
  gradeShortAnswer: ShortAnswerGrader;
}): Promise<PublicAttempt> {
  const stageId = parseStageId(input.stageId);
  const sceneId = parseId(input.sceneId, 'INVALID_SCENE_ID', 'scene id');
  const course = await input.catalog.get(stageId);
  if (!course) throw new SchoolError(404, 'COURSE_NOT_FOUND', 'course not found');
  const provisional = await submissionSource(
    input.repo,
    input.principal,
    stageId,
    course.publishedAt !== null,
  );
  const source = assertOwnerSelfTest(input.principal, course.ownerId, provisional);
  const scene = await input.bank.getScene(stageId, sceneId);
  if (!scene) throw new SchoolError(404, 'QUIZ_NOT_FOUND', 'quiz not found');
  const body = input.body && typeof input.body === 'object' ? input.body : null;
  const rawAnswers = body && 'answers' in body ? body.answers : undefined;
  const answers = parseAnswers(rawAnswers);
  const graded = await gradeScene(scene, answers, languageOf(body), input.gradeShortAnswer);
  const kept: QuizAnswers = {};
  for (const question of scene.questions) {
    const answer = answers[question.id];
    if (answer !== undefined) kept[question.id] = answer;
  }
  const totalScore = graded.perQuestion.reduce((sum, item) => sum + item.earned, 0);
  const totalPoints = graded.perQuestion.reduce((sum, item) => sum + item.maxPoints, 0);
  const stored = await input.repo.insertQuizAttempt({
    id: newAttemptId(),
    ownerId: input.principal.ownerId,
    stageId,
    sceneId,
    answers: kept,
    status: 'graded',
    source,
    result: {
      perQuestion: graded.perQuestion,
      totalScore,
      totalPoints,
      grader: graded.grader,
    },
  });
  return toPublic(stored);
}

function latestByScene(attempts: readonly QuizAttemptRecord[]): QuizAttemptRecord[] {
  const latest = new Map<string, QuizAttemptRecord>();
  for (const attempt of attempts) {
    const key = `${attempt.stageId}\u0000${attempt.sceneId}`;
    const existing = latest.get(key);
    if (!existing || attempt.submittedAt > existing.submittedAt) latest.set(key, attempt);
  }
  return [...latest.values()].sort((a, b) =>
    a.stageId === b.stageId ? (a.sceneId < b.sceneId ? -1 : 1) : a.stageId < b.stageId ? -1 : 1,
  );
}

export async function listOwnResults(input: {
  repo: SchoolRepository;
  principal: OwnerPrincipal;
  stageId?: string | null;
  sceneId?: string | null;
  ownerId?: string | null;
  history: boolean;
}): Promise<OwnResults> {
  assertSignedIn(input.principal);
  if (input.ownerId && input.ownerId !== input.principal.ownerId) {
    throw new SchoolError(403, 'ATTEMPT_FORBIDDEN', 'you can only read your own quiz results');
  }
  const stageId = input.stageId ? parseStageId(input.stageId) : null;
  const sceneId = input.sceneId ? parseId(input.sceneId, 'INVALID_SCENE_ID', 'scene id') : null;
  const attempts = (await input.repo.listQuizAttempts(input.principal.ownerId)).filter(
    (attempt) =>
      (stageId === null || attempt.stageId === stageId) &&
      (sceneId === null || attempt.sceneId === sceneId),
  );
  const results = latestByScene(attempts).map(toPublic);
  if (!input.history) return { results };
  return { results, history: attempts.map(toPublic) };
}

export async function getOwnAttempt(
  repo: SchoolRepository,
  principal: OwnerPrincipal,
  attemptId: string,
): Promise<PublicAttempt> {
  assertSignedIn(principal);
  const id = parseId(attemptId, 'INVALID_ATTEMPT_ID', 'attempt id');
  const attempt = await repo.getQuizAttempt(id);
  if (!attempt) throw new SchoolError(404, 'ATTEMPT_NOT_FOUND', 'attempt not found');
  if (attempt.ownerId !== principal.ownerId && !hasSchoolRole(principal, 'admin')) {
    throw new SchoolError(403, 'ATTEMPT_FORBIDDEN', 'you can only read your own quiz results');
  }
  return toPublic(attempt);
}

async function gradebookRoster(
  repo: SchoolRepository,
  stageId: string,
  schoolClass: SchoolClass,
): Promise<SchoolUser[]> {
  const assignment = await repo.getCourseAssignment(stageId);
  const members = new Set(schoolClass.memberIds);
  const ids = new Set<string>();
  if (assignment.classIds.includes(schoolClass.id)) {
    for (const ownerId of schoolClass.memberIds) ids.add(ownerId);
  }
  for (const ownerId of assignment.studentIds) {
    if (members.has(ownerId)) ids.add(ownerId);
  }
  const users = await repo.getUsers([...ids]);
  return users
    .filter((user) => user.roles.includes('student'))
    .sort((a, b) => {
      const byName = (a.displayName ?? '').localeCompare(b.displayName ?? '');
      return byName !== 0 ? byName : a.ownerId.localeCompare(b.ownerId);
    });
}

function questionStats(
  question: QuizQuestion,
  attempts: readonly QuizAttemptRecord[],
): GradebookQuestion {
  const rows = attempts.filter((attempt) =>
    attempt.result?.perQuestion.some((item) => item.questionId === question.id),
  );
  let correctCount = 0;
  let earned = 0;
  let max = 0;
  for (const attempt of rows) {
    const item = attempt.result?.perQuestion.find((score) => score.questionId === question.id);
    if (!item) continue;
    if (item.correct === true) correctCount += 1;
    earned += item.earned;
    max += item.maxPoints;
  }
  return {
    questionId: question.id,
    maxPoints: pointsOf(question),
    submittedCount: rows.length,
    correctCount,
    accuracy: rate(correctCount, rows.length),
    scoreRate: rate(earned, max),
  };
}

async function sceneGradebook(
  repo: SchoolRepository,
  stageId: string,
  scene: SchoolQuizScene,
  roster: readonly SchoolUser[],
): Promise<GradebookScene> {
  const latest = await repo.listLatestStudentAttempts({
    stageId,
    sceneId: scene.sceneId,
    ownerIds: roster.map((user) => user.ownerId),
  });
  const byOwner = new Map(latest.map((attempt) => [attempt.ownerId, attempt]));
  const students = roster.map((user): GradebookStudent => {
    const attempt = byOwner.get(user.ownerId);
    return {
      ownerId: user.ownerId,
      displayName: user.displayName,
      submitted: Boolean(attempt?.result),
      score: attempt?.result?.totalScore ?? null,
      totalPoints: attempt?.result?.totalPoints ?? null,
      submittedAt: attempt?.submittedAt ?? null,
      attemptId: attempt?.id ?? null,
    };
  });
  const submitted = latest.filter((attempt) => attempt.result);
  const submittedCount = students.filter((student) => student.submitted).length;
  const averageScore =
    submittedCount === 0
      ? null
      : submitted.reduce((sum, attempt) => sum + (attempt.result?.totalScore ?? 0), 0) /
        submittedCount;
  return {
    sceneId: scene.sceneId,
    title: scene.title,
    rosterCount: roster.length,
    submittedCount,
    submissionRate: rate(submittedCount, roster.length),
    averageScore,
    questions: scene.questions.map((question) => questionStats(question, submitted)),
    students,
  };
}

export async function classGradebook(input: {
  repo: SchoolRepository;
  catalog: CourseCatalog;
  bank: QuizBank;
  principal: OwnerPrincipal;
  stageId: string;
  classId: string;
  sceneId?: string | null;
}): Promise<ClassGradebook> {
  assertSignedIn(input.principal);
  const stageId = parseStageId(input.stageId);
  const classId = parseId(input.classId, 'INVALID_CLASS_ID', 'class id');
  const sceneId = input.sceneId ? parseId(input.sceneId, 'INVALID_SCENE_ID', 'scene id') : null;
  const schoolClass = assertClassTeacher(input.principal, await input.repo.getClass(classId));
  const course = await input.catalog.get(stageId);
  if (!course) throw new SchoolError(404, 'COURSE_NOT_FOUND', 'course not found');
  const roster = await gradebookRoster(input.repo, stageId, schoolClass);
  const scenes = await input.bank.listScenes(stageId);
  const selected = sceneId ? scenes.filter((scene) => scene.sceneId === sceneId) : scenes;
  if (sceneId && selected.length === 0) {
    throw new SchoolError(404, 'QUIZ_NOT_FOUND', 'quiz not found');
  }
  return {
    stageId,
    classId,
    published: course.publishedAt !== null,
    scenes: await Promise.all(
      selected.map((scene) => sceneGradebook(input.repo, stageId, scene, roster)),
    ),
  };
}
