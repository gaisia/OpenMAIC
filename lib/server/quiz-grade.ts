/**
 * Short-answer scoring shared by `POST /api/quiz-grade` and the school quiz
 * submit path. Choice questions stay on `gradeChoiceQuestions`. This module
 * only covers the LLM branch: the same prompt, the same JSON parse, and the
 * same half-credit fallback when the model reply is not JSON.
 */
import type { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';

export interface ShortAnswerGradeInput {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

export interface ShortAnswerGrade {
  score: number;
  comment: string;
}

export function shortAnswerPrompt(input: ShortAnswerGradeInput): {
  system: string;
  prompt: string;
} {
  const { question, userAnswer, points, commentPrompt, language } = input;
  const isZh = language === 'zh-CN';
  const system = isZh
    ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
    : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;
  const prompt = isZh
    ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
    : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;
  return { system, prompt };
}

/** Parse a model reply the way `POST /api/quiz-grade` always has. */
export function interpretShortAnswerGrade(
  text: string,
  points: number,
  language?: string,
): ShortAnswerGrade {
  const isZh = language === 'zh-CN';
  try {
    const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; comment?: unknown };
    return {
      score: Math.max(0, Math.min(points, Math.round(Number(parsed.score)))),
      comment: String(parsed.comment || ''),
    };
  } catch {
    return {
      score: Math.round(points * 0.5),
      comment: isZh
        ? '已作答，请参考标准答案。'
        : 'Answer received. Please refer to the standard answer.',
    };
  }
}

/**
 * Grade one short answer with the caller's classroom model. Throws when the
 * model call fails; a non-JSON reply is not a failure (half credit).
 */
export async function gradeShortAnswerFromRequest(
  req: NextRequest,
  input: ShortAnswerGradeInput,
): Promise<ShortAnswerGrade> {
  const { model, thinkingConfig, serverManaged } = await resolveModelFromRequest(
    req,
    input,
    'quiz-grade',
  );
  const prompts = shortAnswerPrompt(input);
  const result = await callLLM(
    {
      model,
      system: prompts.system,
      prompt: prompts.prompt,
    },
    'quiz-grade',
    undefined,
    thinkingConfig,
    { serverManaged },
  );
  return interpretShortAnswerGrade(result.text, input.points, input.language);
}
