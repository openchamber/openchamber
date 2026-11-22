import { z } from "zod"
import type { FormField, FormValue } from "@opencode/client"
import type { FormRequest, ToolInput, ToolState } from "./model"

/**
 * OpenCode's `question` tool (`packages/core/src/tool/plugin/question.ts`):
 * the agent sends `{ questions: Question.Prompt[] }`, OpenCode turns them into
 * one form request whose field `q<n>` is question `n`, and an answered call
 * returns `metadata.answers`, one string list per question in the same order.
 * The transcript keeps the input after the call ends however it ended, so a
 * question can be shown and answered again from the tool row.
 */

export type QuestionOption = { label: string; description: string }

export type QuestionPrompt = {
  header: string
  question: string
  options: QuestionOption[]
  multiple: boolean
}

/** One question's answer: the chosen option labels and any text typed instead. */
export type QuestionAnswer = string[]

const textSchema = z.string().catch("")

// Each entry falls back field by field, never dropping out: answers are
// matched to questions by position, so a lost entry would shift every
// answer after it onto the wrong question.
const promptSchema = z
  .object({
    header: textSchema,
    question: textSchema,
    options: z.array(z.object({ label: textSchema, description: textSchema }).catch({ label: "", description: "" })).catch([]),
    multiple: z.boolean().catch(false),
  })
  .catch({ header: "", question: "", options: [], multiple: false })

const inputSchema = z.object({ questions: z.array(promptSchema).catch([]) }).catch({ questions: [] })

/** The questions a `question` call asked, in order; empty when its input holds none. */
export function questionPrompts(input: ToolInput | undefined): QuestionPrompt[] {
  return inputSchema.parse(input ?? {}).questions.map((prompt) => ({
    ...prompt,
    options: prompt.options.filter((option) => option.label.length > 0),
  }))
}

const answersSchema = z.array(z.array(z.string()))

/** The answers an answered call returned, by question; null when the call has none. */
export function questionAnswers(state: ToolState): QuestionAnswer[] | null {
  if (state.status !== "completed") return null
  const parsed = answersSchema.safeParse(state.metadata?.answers)
  return parsed.success ? parsed.data : null
}

/**
 * The form fields OpenCode builds for these questions, field for field
 * (`toField` in OpenCode's question tool), so a question answered again
 * looks and validates the way it did when the agent asked it.
 */
export function questionFormFields(prompts: readonly QuestionPrompt[]): FormField[] {
  return prompts.map((prompt, index): FormField => {
    const options = prompt.options.map((option) => ({ value: option.label, label: option.label, description: option.description }))
    const shared = { key: `q${index}`, title: prompt.header, description: prompt.question, custom: true }
    return prompt.multiple ? { ...shared, type: "multiselect", options } : { ...shared, type: "string", options }
  })
}

/** The answer a field holds in OpenCode's form reply, as the tool reports it. */
export function questionAnswerOf(value: FormValue | undefined): QuestionAnswer {
  if (value === undefined) return []
  if (Array.isArray(value)) return [...value]
  return [String(value)]
}

const questionFormMetadataSchema = z.object({
  kind: z.literal("question"),
  tool: z.object({ messageID: z.string().min(1), id: z.string().min(1) }),
})

/** Identifies one `question` call across its form request and its transcript row. */
export type QuestionCallRef = { messageID: string; callID: string }

/** The `question` call a form request belongs to; null for any other form. */
export function questionFormCall(form: Pick<FormRequest, "metadata">): QuestionCallRef | null {
  const parsed = questionFormMetadataSchema.safeParse(form.metadata)
  return parsed.success ? { messageID: parsed.data.tool.messageID, callID: parsed.data.tool.id } : null
}

export const questionCallKey = (call: QuestionCallRef): string => `${call.messageID}:${call.callID}`

export type QuestionOutputPair = { question: string; answer: string }

/**
 * The `"question"="answer"` pairs of an answered call's text result ("User
 * has answered your questions: ... You can now ..."), for calls recorded
 * before OpenCode returned `metadata.answers`.
 */
export function parseQuestionOutput(output: string): QuestionOutputPair[] | null {
  const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s)
  if (!match) return null
  const pairs: QuestionOutputPair[] = []
  // Match "question"="answer" pairs, handling multiline answers
  const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g
  let pairMatch
  while ((pairMatch = pairRegex.exec(match[1])) !== null) {
    pairs.push({ question: pairMatch[1], answer: pairMatch[2] })
  }
  return pairs.length > 0 ? pairs : null
}

/** What the expanded row of a `question` call shows. */
export type QuestionRowContent =
  /** The questions with their options, and the answers once returned, however the call ended. */
  | { kind: "questions" }
  /** An answered call recorded before `metadata.answers`: the pairs from its text result. */
  | { kind: "legacy"; pairs: QuestionOutputPair[] }
  /** A failed call whose input holds no questions. */
  | { kind: "error"; message: string }
  | { kind: "awaiting" }

export function questionRowContent(state: ToolState, output: string): QuestionRowContent {
  if (state.status === "completed" && questionAnswers(state) === null) {
    const pairs = parseQuestionOutput(output)
    if (pairs) return { kind: "legacy", pairs }
  }
  if (questionPrompts(state.input).length > 0) return { kind: "questions" }
  if (state.status === "error") return { kind: "error", message: state.error }
  return { kind: "awaiting" }
}
