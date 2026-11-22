import { create } from "zustand"
import { z } from "zod"
import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, Message, Metadata, Part, ToolPart } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"

type QuestionToolLink = { messageID: string; toolID: string }
export type QuestionAskOutcome = "answered" | "dismissed" | "deferred" | "turn-death" | "shutdown" | "pending" | "unresolved"
type ClosedOutcome = "answered" | "dismissed"

export const DEFERRED_QUESTION_NOTE = "The user has not answered this question. They sent a message instead; it follows this result. Do not choose an answer for them, and do not do anything this question was meant to decide. Do not ask the same question again now; an answer may arrive later as a separate message. Continue with what the message asks. If you cannot continue without the answer, say so and stop."

export const DEFERRED_ANSWER_LEAD_IN = "Answer to your earlier question:"

export type RecoveredQuestion = {
  form: FormRequest
  directory: string
  sessionID: string
  toolMessageID: string
  evidence: "tool-interrupted" | "local-interrupt-mark" | "deferred-on-send"
}

type SeenQuestion = {
  form: FormRequest
  directory: string
  sessionID: string
  tool: QuestionToolLink
}

type RecoverableQuestionsState = {
  seen: ReadonlyMap<string, SeenQuestion>
  outcomes: ReadonlyMap<string, ClosedOutcome>
  dispositions: ReadonlyMap<string, { sessionID: string; outcome: QuestionAskOutcome }>
  submissions: ReadonlyMap<string, Promise<void>>
  releasedForms: ReadonlySet<string>
}

const EMPTY_STATE: RecoverableQuestionsState = {
  seen: new Map(), outcomes: new Map(), dispositions: new Map(), submissions: new Map(), releasedForms: new Set(),
}
const MAX_SEEN_QUESTIONS = 100
export const useRecoverableQuestionsStore = create<RecoverableQuestionsState>(() => EMPTY_STATE)
export const resetRecoverableQuestions = (): void => {
  useRecoverableQuestionsStore.setState(EMPTY_STATE)
}

const toolKey = (tool: QuestionToolLink): string => `${tool.messageID}\u0000${tool.toolID}`
const questionKey = (sessionID: string, formID: string): string => `${sessionID}\u0000${formID}`

export function formToolLink(form: FormRequest): QuestionToolLink | null {
  if (form.sessionID === "global") return null
  const tool = form.metadata?.tool
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null
  const { messageID, id } = tool
  if (typeof messageID !== "string" || !messageID || typeof id !== "string" || !id) return null
  return { messageID, toolID: id }
}

export function questionToolLink(form: FormRequest): QuestionToolLink | null {
  return form.metadata?.kind === "question" ? formToolLink(form) : null
}

export type FormTurnHold = "holds" | "released" | "unknown"

export function formTurnHold(
  form: FormRequest,
  parts: Readonly<Record<string, readonly Part[] | undefined>>,
  releasedForms: ReadonlySet<string> = EMPTY_STATE.releasedForms,
): FormTurnHold {
  const tool = formToolLink(form)
  if (!tool) return "holds"
  if (releasedForms.has(formReleaseKey(form, tool))) return "released"
  const part = parts[tool.messageID]?.find((candidate) => candidate.id === tool.toolID)
  if (!part) return "unknown"
  if (part.type !== "tool") return "holds"
  return part.state.status === "completed" || part.state.status === "error" ? "released" : "holds"
}

export function isWaitingQuestionCall(form: FormRequest, parts: Readonly<Record<string, readonly Part[] | undefined>>): boolean {
  const tool = questionToolLink(form)
  if (!tool) return false
  const part = parts[tool.messageID]?.find((candidate) => candidate.id === tool.toolID)
  return part?.type === "tool" && part.tool === "question"
    && (part.state.status === "pending" || part.state.status === "running")
}

export const formReleaseKey = (form: FormRequest, tool: QuestionToolLink): string =>
  `${form.sessionID}\u0000${form.id}\u0000${toolKey(tool)}`

export function noteFormToolReleased(key: string, openKeys: ReadonlySet<string>): void {
  useRecoverableQuestionsStore.setState((state) => {
    const releasedForms = new Set([...state.releasedForms].filter((entry) => openKeys.has(entry))).add(key)
    if (releasedForms.size === state.releasedForms.size && state.releasedForms.has(key)) return state
    return { releasedForms }
  })
}

function forgetReleasedForm(sessionID: string, formID: string): void {
  const prefix = `${sessionID}\u0000${formID}\u0000`
  useRecoverableQuestionsStore.setState((state) => {
    if (![...state.releasedForms].some((key) => key.startsWith(prefix))) return state
    return { releasedForms: new Set([...state.releasedForms].filter((key) => !key.startsWith(prefix))) }
  })
}

const QUESTION_DISMISSED_ERROR = "The user dismissed this question"

export function classifyQuestionToolError(error: string, errorType: string | undefined, local: boolean): QuestionAskOutcome {
  if (local) return error === "Interrupted" ? "turn-death" : "unresolved"
  if (error === DEFERRED_QUESTION_NOTE) return "deferred"
  if (errorType === "unknown" && error === QUESTION_DISMISSED_ERROR) return "dismissed"
  if (errorType !== undefined && errorType !== "aborted" && errorType !== "unknown") return "dismissed"
  if (error.startsWith("Tool execution interrupted")) return "turn-death"
  if (error === "All fibers interrupted without error") return "turn-death"
  if (error === "Interaction cancelled because the location shut down") return "shutdown"
  return "unresolved"
}

function partAskOutcome(part: ToolPart | undefined): QuestionAskOutcome {
  const state = part?.state
  if (!state) return "unresolved"
  if (state.status === "completed") return "answered"
  if (state.status === "error") return classifyQuestionToolError(state.error, state.errorType, state.errorSource === "local")
  return "pending"
}

export type RecoverableQuestionStateView = Pick<RecoverableQuestionsState, "seen" | "outcomes" | "dispositions">
export type RecoverableQuestionStoreView = {
  form: Readonly<Record<string, readonly FormRequest[] | undefined>>
  part: Readonly<Record<string, readonly Part[] | undefined>>
}

export function deriveRecoveredQuestions(
  state: RecoverableQuestionStoreView,
  recovery: RecoverableQuestionStateView,
  scopeSessionIds: ReadonlySet<string>,
): RecoveredQuestion[] {
  const recovered: RecoveredQuestion[] = []
  for (const [key, seen] of recovery.seen) {
    if (recovery.outcomes.has(key) || !scopeSessionIds.has(seen.sessionID)) continue
    if (state.form[seen.sessionID]?.some((form) => form.id === seen.form.id)) continue
    const candidate = state.part[seen.tool.messageID]?.find((part) => part.id === seen.tool.toolID)
    const part = candidate?.type === "tool" ? candidate : undefined
    const outcome = recovery.dispositions.get(toolKey(seen.tool))?.outcome ?? partAskOutcome(part)
    if (outcome !== "turn-death" && outcome !== "deferred") continue
    recovered.push({
      form: seen.form,
      directory: seen.directory,
      sessionID: seen.sessionID,
      toolMessageID: seen.tool.messageID,
      evidence: outcome === "deferred"
        ? "deferred-on-send"
        : part?.state.status === "error" && part.state.errorSource === "local" ? "local-interrupt-mark" : "tool-interrupted",
    })
  }
  return recovered
}

function noteQuestionFormSeen(form: FormRequest, directory: string): void {
  const tool = questionToolLink(form)
  if (!tool) return
  useRecoverableQuestionsStore.setState((state) => {
    const key = questionKey(form.sessionID, form.id)
    if (state.seen.has(key)) return state
    const seen = new Map(state.seen).set(key, { form, directory, sessionID: form.sessionID, tool })
    const outcomes = new Map(state.outcomes)
    const dispositions = new Map(state.dispositions)
    while (seen.size > MAX_SEEN_QUESTIONS) {
      const oldest = seen.entries().next().value
      if (!oldest) break
      seen.delete(oldest[0])
      outcomes.delete(oldest[0])
      const key = toolKey(oldest[1].tool)
      if (![...seen.values()].some((entry) => toolKey(entry.tool) === key)) dispositions.delete(key)
    }
    return { seen, outcomes, dispositions }
  })
}

export function noteQuestionFormSnapshot(directory: string, forms: readonly FormRequest[]): void {
  for (const form of forms) noteQuestionFormSeen(form, directory)
}

function closeQuestion(sessionID: string, formID: string, outcome: ClosedOutcome): void {
  useRecoverableQuestionsStore.setState((state) => {
    const key = questionKey(sessionID, formID)
    if (!state.seen.has(key) || state.outcomes.has(key)) return state
    return { outcomes: new Map(state.outcomes).set(key, outcome) }
  })
}

let liveFormRemovalClock = 0
const liveFormRemovals = new Map<string, number>()
const liveFormReadStarts: number[] = []

const liveFormKey = (runtimeKey: string, sessionID: string, formID: string): string =>
  `${runtimeKey}\u0000${sessionID}\u0000${formID}`

function noteLiveFormRemoved(sessionID: string, formID: string): void {
  if (liveFormReadStarts.length === 0) return
  liveFormRemovals.set(liveFormKey(getRuntimeKey(), sessionID, formID), ++liveFormRemovalClock)
}

export function noteLocalFormReplied(sessionID: string, formID: string): void {
  noteLiveFormRemoved(sessionID, formID)
  closeQuestion(sessionID, formID, "answered")
}

export function noteLocalFormCancelled(sessionID: string, formID: string, message?: string): void {
  noteLiveFormRemoved(sessionID, formID)
  if (message === undefined) closeQuestion(sessionID, formID, "dismissed")
}

export async function readLiveForms<T>(read: () => Promise<FormRequest[]>, apply: (forms: FormRequest[]) => T): Promise<T> {
  const startedAt = liveFormRemovalClock
  liveFormReadStarts.push(startedAt)
  try {
    const forms = await read()
    const runtimeKey = getRuntimeKey()
    return apply(forms.filter((form) => !liveFormRemovals.has(liveFormKey(runtimeKey, form.sessionID, form.id))))
  } finally {
    liveFormReadStarts.splice(liveFormReadStarts.indexOf(startedAt), 1)
    const oldestRead = liveFormReadStarts.length > 0 ? Math.min(...liveFormReadStarts) : Infinity
    for (const [key, removedAt] of liveFormRemovals) if (removedAt <= oldestRead) liveFormRemovals.delete(key)
  }
}

export const deferredAnswerMetadata = (formID: string): Metadata => ({ openchamber: { deferredAnswer: { formID } } })

const deferredAnswerSchema = z.object({ openchamber: z.object({ deferredAnswer: z.object({ formID: z.string().min(1) }) }) })

const deferredAnswerFormID = (message: Message): string | undefined =>
  message.role === "user" ? deferredAnswerSchema.safeParse(message.metadata ?? {}).data?.openchamber.deferredAnswer.formID : undefined

export function noteDeferredAnswersLoaded(messages: Readonly<Record<string, readonly Message[] | undefined>>): void {
  const { seen, outcomes } = useRecoverableQuestionsStore.getState()
  const sessions = new Set<string>()
  for (const [key, entry] of seen) if (!outcomes.has(key)) sessions.add(entry.sessionID)
  for (const sessionID of sessions) {
    for (const message of messages[sessionID] ?? []) {
      const formID = deferredAnswerFormID(message)
      if (formID) noteLocalFormReplied(sessionID, formID)
    }
  }
}

export function submitRecoveredAnswer(sessionID: string, formID: string, send: () => Promise<void>): Promise<void> {
  const key = questionKey(sessionID, formID)
  const state = useRecoverableQuestionsStore.getState()
  if (state.outcomes.has(key)) return Promise.resolve()
  const existing = state.submissions.get(key)
  if (existing) return existing
  const run = send().finally(() => {
    useRecoverableQuestionsStore.setState((current) => {
      if (current.submissions.get(key) !== run) return current
      const submissions = new Map(current.submissions)
      submissions.delete(key)
      return { submissions }
    })
  })
  useRecoverableQuestionsStore.setState((current) => ({ submissions: new Map(current.submissions).set(key, run) }))
  return run
}

function recordDisposition(sessionID: string, tool: QuestionToolLink, outcome: QuestionAskOutcome): void {
  useRecoverableQuestionsStore.setState((state) => {
    const key = toolKey(tool)
    for (const entry of state.seen.values()) {
      if (entry.sessionID !== sessionID || toolKey(entry.tool) !== key) continue
      const previous = state.dispositions.get(key)?.outcome
      if (previous === outcome || previous === "answered" || previous === "dismissed" || previous === "shutdown") return state
      return { dispositions: new Map(state.dispositions).set(key, { sessionID, outcome }) }
    }
    return state
  })
}

function dropSession(sessionID: string): void {
  useRecoverableQuestionsStore.setState((state) => {
    const seen = new Map(state.seen)
    const outcomes = new Map(state.outcomes)
    for (const [key, entry] of seen) {
      if (entry.sessionID !== sessionID) continue
      seen.delete(key)
      outcomes.delete(key)
    }
    const dispositions = new Map(state.dispositions)
    for (const [key, entry] of dispositions) if (entry.sessionID === sessionID) dispositions.delete(key)
    return { seen, outcomes, dispositions }
  })
}

export function applyRecoverableQuestionEvents(directory: string, events: readonly SyncEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "form.created":
        noteQuestionFormSeen(event.properties.form, directory)
        break
      case "form.settled":
        forgetReleasedForm(event.properties.sessionID, event.properties.formID)
        if (event.properties.disposition === "replied") noteLocalFormReplied(event.properties.sessionID, event.properties.formID)
        break
      case "message.updated": {
        const { info } = event.properties
        const formID = deferredAnswerFormID(info)
        if (formID) noteLocalFormReplied(info.sessionID, formID)
        break
      }
      case "message.tool.transition": {
        const { sessionID, messageID, partID, transition } = event.properties
        const tool = { messageID, toolID: partID }
        if (transition.kind === "success") recordDisposition(sessionID, tool, "answered")
        else if (transition.kind === "failed") {
          recordDisposition(sessionID, tool, classifyQuestionToolError(transition.error, transition.errorType, false))
        }
        break
      }
      case "session.deleted":
        dropSession(event.properties.sessionID)
        break
    }
  }
}
