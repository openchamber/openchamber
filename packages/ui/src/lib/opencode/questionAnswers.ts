import { z } from "zod"

import type { Metadata, ToolInput, ToolState } from "./model"
import type { ToolName } from "./tool-name"
import { isQuestionTool } from "./tools"

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

export function answeredQuestions(toolName: ToolName, state: ToolState): RecordedQuestionAnswer[] | null {
  if (!isQuestionTool(toolName) || state.status !== "completed") return null
  const answers = recordedQuestionAnswers(state.input, state.metadata)
  return answers?.some((answer) => answer.picks.length > 0) ? answers : null
}
