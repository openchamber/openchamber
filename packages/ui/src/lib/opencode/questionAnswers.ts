import { z } from "zod"

import type { Metadata, ToolInput } from "./model"

const askedQuestionsSchema = z.object({ questions: z.array(z.object({ question: z.string() })).min(1) })

const recordedAnswersSchema = z.object({ answers: z.array(z.array(z.string())) })

export type RecordedQuestionAnswer = { question: string; picks: string[] }

export function recordedQuestionAnswers(input: ToolInput | undefined, metadata: Metadata | undefined): RecordedQuestionAnswer[] | null {
  const asked = askedQuestionsSchema.safeParse(input)
  const recorded = recordedAnswersSchema.safeParse(metadata)
  if (!asked.success || !recorded.success || recorded.data.answers.length !== asked.data.questions.length) return null
  return asked.data.questions.map((question, index) => ({
    question: question.question,
    picks: recorded.data.answers[index].filter((pick) => pick.length > 0),
  }))
}

