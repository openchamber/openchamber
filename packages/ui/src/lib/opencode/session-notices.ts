
import { z } from "zod"

import { readContextPart } from "@/lib/messages/contextParts"

import { readShellCancellation, readShellCompletion } from "./background-shell"
import { readDispatchedSessionResult } from "./dispatched-session"
import { readWorkflowReport } from "@/lib/workflows/report"
import { readShareAnswer } from "@/lib/share-pages/answer"
import type { Message, Metadata, Part, ToolPart } from "./model"
import { LEAD_ANSWER_METADATA_KEY, leadReplySchema } from "@/lib/sessionLead"
import { isSubagentCancellationNote, readSubagentRun } from "./subagent-run"

const pullRequestNoticeSchema = z.object({
  kind: z.literal("pull-request"),
  url: z.string().min(1),
  number: z.number(),
  events: z.array(z.enum(["merged", "closed", "checks-failed", "checks-passed", "conflict", "behind", "activity"])).min(1),
  failedChecks: z.array(z.string()),
  authors: z.array(z.string()),
  text: z.string(),
})

export type PullRequestNotice = z.infer<typeof pullRequestNoticeSchema>

const extensionWaitNoticeSchema = z.object({
  kind: z.literal("extension-wait"),
  subject: z.string().min(1),
  outcome: z.enum(["fired", "ended"]),
  summary: z.string(),
  timerMinutes: z.number().optional(),
  text: z.string(),
})

export type ExtensionWaitNotice = z.infer<typeof extensionWaitNoticeSchema>

const pageAnswerOutcomeSchema = z.enum(["answered", "declined", "ui-not-drawn"])

const pageAnswerNoticeSchema = z.object({
  kind: z.literal("page-answer"),
  title: z.string(),
  outcome: pageAnswerOutcomeSchema,
  summary: z.string(),
  details: z.string(),
  text: z.string(),
})

export type PageAnswerNotice = z.infer<typeof pageAnswerNoticeSchema>

const leadAnswerNoticeSchema = z.object({
  kind: z.literal("lead-answer"),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
  suggestions: z.array(z.object({ item: z.string(), accepted: z.boolean() })),
  text: z.string(),
})
const leadHandoverNoticeSchema = z.object({ kind: z.literal("lead-handover"), title: z.string(), text: z.string() })

export type LeadNotice = z.infer<typeof leadAnswerNoticeSchema> | z.infer<typeof leadHandoverNoticeSchema>

export type SessionNotice =
  | { kind: "plugin"; label: string; text: string }
  | { kind: "restart"; text: string }
  | { kind: "command-failed"; command: string; text: string }
  | { kind: "moved"; folder: string | null; text: string }
  | PullRequestNotice
  | ExtensionWaitNotice
  | PageAnswerNotice
  | LeadNotice

const HIDDEN_DESCRIPTIONS = new Set(["ACP embedded context"])

const restartSchema = z.object({ notice: z.literal("restart") })
const instructionsLoadedSchema = z.object({ instruction: z.object({ paths: z.array(z.string()) }) })
const failedCommandSchema = z.object({ source: z.literal("shell"), state: z.literal("error") })

const instructionsUpdatedSchema = z.object({ notice: z.literal("instructions"), instructionSources: z.array(z.string()) })
const ENVIRONMENT_SOURCE = "core/environment"
const WORKING_DIRECTORY_LINE = /^\s*Working directory: (.+)$/m

const readMove = (message: Extract<Message, { role: "system" }>): SessionNotice | undefined => {
  const parsed = instructionsUpdatedSchema.safeParse(message.metadata ?? {})
  if (!parsed.success || !parsed.data.instructionSources.includes(ENVIRONMENT_SOURCE)) return undefined
  const folder = message.text.match(WORKING_DIRECTORY_LINE)?.[1]?.trim() || null
  return { kind: "moved", folder, text: message.text }
}

const pullRequestWakeSchema = pullRequestNoticeSchema.pick({ url: true, events: true }).extend({
  source: z.literal("openchamber-pr-watch"),
  failedChecks: z.array(z.string()).default([]),
  authors: z.array(z.string()).default([]),
})
const PULL_REQUEST_NUMBER = /^\s*<openchamber-pull-request\b[^>]*\bnumber="(\d+)"/

const readPullRequestWake = (text: string, metadata: Metadata): PullRequestNotice | undefined => {
  const parsed = pullRequestWakeSchema.safeParse(metadata)
  const number = text.match(PULL_REQUEST_NUMBER)?.[1]
  if (!parsed.success || !number) return undefined
  const { url, events, failedChecks, authors } = parsed.data
  return { kind: "pull-request", url, number: Number(number), events, failedChecks, authors, text }
}

const extensionWaitWakeSchema = extensionWaitNoticeSchema.pick({ subject: true, outcome: true, summary: true }).extend({
  source: z.literal("openchamber-wait"),
  extension: z.string().nullable().optional().catch(undefined),
  type: z.string().optional().catch(undefined),
  minutes: z.number().optional().catch(undefined),
})

const readExtensionWaitWake = (text: string, metadata: Metadata): ExtensionWaitNotice | undefined => {
  const parsed = extensionWaitWakeSchema.safeParse(metadata)
  if (!parsed.success) return undefined
  const { subject, outcome, summary, extension, type, minutes } = parsed.data
  const builtInTimer = extension === null && type === "timer" && minutes !== undefined
  return builtInTimer
    ? { kind: "extension-wait", subject, outcome, summary, timerMinutes: minutes, text }
    : { kind: "extension-wait", subject, outcome, summary, text }
}

const pageAnswerWakeSchema = z.object({
  source: z.literal("openchamber-page-answer"),
  title: z.string(),
  outcome: pageAnswerOutcomeSchema,
})
const findPageAnswerFieldsLine = (text: string) => text.split("\n").find((line) => line.startsWith("{") && line.endsWith("}"))
const pageAnswerFieldsSchema = z.object({
  page: z.string().catch(""),
  summary: z.string().catch(""),
  data: z.json().optional().catch(undefined),
  errors: z.array(z.string()).catch([]),
})

const readPageAnswerFields = (text: string) => {
  const line = findPageAnswerFieldsLine(text)
  if (!line) return pageAnswerFieldsSchema.parse({})
  try {
    return pageAnswerFieldsSchema.parse(JSON.parse(line))
  } catch {
    return pageAnswerFieldsSchema.parse({})
  }
}

const readPageAnswerWake = (text: string, metadata: Metadata): PageAnswerNotice | undefined => {
  const parsed = pageAnswerWakeSchema.safeParse(metadata)
  if (!parsed.success) return undefined
  const { title, outcome } = parsed.data
  const fields = readPageAnswerFields(text)
  const summary = outcome === "answered" ? fields.summary.replace(/\s+/g, " ").trim() : ""
  const details = outcome === "answered"
    ? (fields.data === undefined || fields.data === null ? fields.summary : `\`\`\`json\n${JSON.stringify(fields.data, null, 2)}\n\`\`\``)
    : outcome === "ui-not-drawn" ? fields.errors.map((error) => `- ${error}`).join("\n") : ""
  return { kind: "page-answer", title, outcome, summary, details, text }
}

const leadReplyMetadataSchema = z.object({ [LEAD_ANSWER_METADATA_KEY]: leadReplySchema })
const leadHandoverMetadataSchema = z.object({ source: z.literal("openchamber-lead-handover"), title: z.string() })

const readLeadNotice = (text: string, metadata: Metadata): LeadNotice | undefined => {
  const reply = leadReplyMetadataSchema.safeParse(metadata).data?.[LEAD_ANSWER_METADATA_KEY]
  if (reply) return { kind: "lead-answer", answers: reply.answers, suggestions: reply.suggestions, text }
  const handover = leadHandoverMetadataSchema.safeParse(metadata).data
  return handover ? { kind: "lead-handover", title: handover.title, text } : undefined
}

export function readSessionNotice(message: Message): SessionNotice | undefined {
  if (message.role === "system") return readMove(message)
  if (message.role !== "synthetic") return undefined
  const lead = readLeadNotice(message.text, message.metadata ?? {})
  if (lead) return lead
  const description = message.description?.trim()
  if (!description) return undefined
  const metadata = message.metadata ?? {}
  if (readContextPart({ type: "text", metadata: message.metadata })) return undefined
  if (readSubagentRun(message) || readDispatchedSessionResult(message) || readWorkflowReport(message) || readShareAnswer(message)) return undefined
  if (readShellCompletion(message) || readShellCancellation(message) || isSubagentCancellationNote(message)) return undefined
  if (HIDDEN_DESCRIPTIONS.has(description) || instructionsLoadedSchema.safeParse(metadata).success) return undefined
  const text = message.text
  if (restartSchema.safeParse(metadata).success) return { kind: "restart", text }
  if (failedCommandSchema.safeParse(metadata).success) return { kind: "command-failed", command: description, text }
  return readPullRequestWake(text, metadata)
    ?? readExtensionWaitWake(text, metadata)
    ?? readPageAnswerWake(text, metadata)
    ?? { kind: "plugin", label: description, text }
}


const SESSION_NOTICE_TOOL = "openchamber-session-notice"

const NOTICE_METADATA_KEY = "openchamberSessionNotice"

const noticeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plugin"), label: z.string(), text: z.string() }),
  z.object({ kind: z.literal("restart"), text: z.string() }),
  z.object({ kind: z.literal("command-failed"), command: z.string(), text: z.string() }),
  z.object({ kind: z.literal("moved"), folder: z.string().nullable(), text: z.string() }),
  pullRequestNoticeSchema,
  extensionWaitNoticeSchema,
  pageAnswerNoticeSchema,
  leadAnswerNoticeSchema,
  leadHandoverNoticeSchema,
])

const noticePartMetadataSchema = z.object({ [NOTICE_METADATA_KEY]: noticeSchema })

export type SessionNoticePlacement = "before" | "after"

const PLACEMENT_METADATA_KEY = "openchamberSessionNoticePlacement"

const placementMetadataSchema = z.object({ [PLACEMENT_METADATA_KEY]: z.enum(["before", "after"]) })

export function sessionNoticePart(
  message: Message,
  notice: SessionNotice,
  ownerMessageID: string,
  placement: SessionNoticePlacement,
): ToolPart {
  const created = message.time.created
  return {
    id: `notice:${message.id}`,
    sessionID: message.sessionID,
    messageID: ownerMessageID,
    type: "tool",
    callID: message.id,
    tool: SESSION_NOTICE_TOOL,
    state: {
      status: "completed",
      input: {},
      output: notice.text,
      metadata: { [NOTICE_METADATA_KEY]: notice, [PLACEMENT_METADATA_KEY]: placement } satisfies Metadata,
      time: { start: created, end: created },
    },
  }
}

export function readSessionNoticePart(part: ToolPart): SessionNotice | undefined {
  if (part.tool !== SESSION_NOTICE_TOOL || part.state.status !== "completed") return undefined
  const parsed = noticePartMetadataSchema.safeParse(part.state.metadata ?? {})
  return parsed.success ? parsed.data[NOTICE_METADATA_KEY] : undefined
}

export const isSessionNoticePart = (part: Part): boolean => part.type === "tool" && part.tool === SESSION_NOTICE_TOOL

export function sessionNoticePlacement(part: Part): SessionNoticePlacement | undefined {
  if (!isSessionNoticePart(part) || part.type !== "tool" || part.state.status !== "completed") return undefined
  const parsed = placementMetadataSchema.safeParse(part.state.metadata ?? {})
  return parsed.success ? parsed.data[PLACEMENT_METADATA_KEY] : undefined
}
