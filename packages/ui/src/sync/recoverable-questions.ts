import { create } from "zustand"
import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, Part, ToolPart } from "@/lib/opencode/model"

type QuestionToolLink = { messageID: string; toolID: string }
export type QuestionAskOutcome = "answered" | "dismissed" | "turn-death" | "shutdown" | "pending" | "unresolved"
type ClosedOutcome = "answered" | "dismissed"

export type RecoveredQuestion = {
  form: FormRequest
  directory: string
  sessionID: string
  toolMessageID: string
  evidence: "tool-interrupted" | "local-interrupt-mark"
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
}

const EMPTY_STATE: RecoverableQuestionsState = {
  seen: new Map(), outcomes: new Map(), dispositions: new Map(), submissions: new Map(),
}
const MAX_SEEN_QUESTIONS = 100
export const useRecoverableQuestionsStore = create<RecoverableQuestionsState>(() => EMPTY_STATE)
export const resetRecoverableQuestions = (): void => {
  useRecoverableQuestionsStore.setState(EMPTY_STATE)
}

const toolKey = (tool: QuestionToolLink): string => `${tool.messageID}\u0000${tool.toolID}`

export function questionToolLink(form: FormRequest): QuestionToolLink | null {
  const metadata = form.metadata
  if (form.sessionID === "global" || metadata?.kind !== "question") return null
  const tool = metadata.tool
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null
  const { messageID, id } = tool
  if (typeof messageID !== "string" || !messageID || typeof id !== "string" || !id) return null
  return { messageID, toolID: id }
}

// Unknown wording fails closed. Shutdown keeps OpenCode's turn resumable.
export function classifyQuestionToolError(error: string, errorType: string | undefined, local: boolean): QuestionAskOutcome {
  if (local) return error === "Interrupted" ? "turn-death" : "unresolved"
  if (errorType !== undefined && errorType !== "aborted") return "dismissed"
  if (error === "Tool execution interrupted") return "turn-death"
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
  for (const [formID, seen] of recovery.seen) {
    if (recovery.outcomes.has(formID) || !scopeSessionIds.has(seen.sessionID)) continue
    if (state.form[seen.sessionID]?.some((form) => form.id === formID)) continue
    const candidate = state.part[seen.tool.messageID]?.find((part) => part.id === seen.tool.toolID)
    const part = candidate?.type === "tool" ? candidate : undefined
    // A later server event can revoke a locally manufactured interruption.
    const outcome = recovery.dispositions.get(toolKey(seen.tool))?.outcome ?? partAskOutcome(part)
    if (outcome !== "turn-death") continue
    recovered.push({
      form: seen.form,
      directory: seen.directory,
      sessionID: seen.sessionID,
      toolMessageID: seen.tool.messageID,
      evidence: part?.state.status === "error" && part.state.errorSource === "local"
        ? "local-interrupt-mark" : "tool-interrupted",
    })
  }
  return recovered
}

function noteQuestionFormSeen(form: FormRequest, directory: string): void {
  const tool = questionToolLink(form)
  if (!tool) return
  useRecoverableQuestionsStore.setState((state) => {
    if (state.seen.has(form.id)) return state
    const seen = new Map(state.seen).set(form.id, { form, directory, sessionID: form.sessionID, tool })
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

// Absence from a partial or failed snapshot is never settlement evidence.
export function noteQuestionFormSnapshot(directory: string, forms: readonly FormRequest[]): void {
  for (const form of forms) noteQuestionFormSeen(form, directory)
}

function closeQuestion(formID: string, outcome: ClosedOutcome): void {
  useRecoverableQuestionsStore.setState((state) => {
    if (!state.seen.has(formID) || state.outcomes.has(formID)) return state
    return { outcomes: new Map(state.outcomes).set(formID, outcome) }
  })
}

export const noteLocalFormReplied = (formID: string): void => closeQuestion(formID, "answered")
export const noteLocalFormCancelled = (formID: string): void => closeQuestion(formID, "dismissed")

export function submitRecoveredAnswer(formID: string, send: () => Promise<void>): Promise<void> {
  const state = useRecoverableQuestionsStore.getState()
  if (state.outcomes.has(formID)) return Promise.resolve()
  const existing = state.submissions.get(formID)
  if (existing) return existing
  const run = send().finally(() => {
    useRecoverableQuestionsStore.setState((current) => {
      if (current.submissions.get(formID) !== run) return current
      const submissions = new Map(current.submissions)
      submissions.delete(formID)
      return { submissions }
    })
  })
  useRecoverableQuestionsStore.setState((current) => ({ submissions: new Map(current.submissions).set(formID, run) }))
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
    for (const [formID, entry] of seen) {
      if (entry.sessionID !== sessionID) continue
      seen.delete(formID)
      outcomes.delete(formID)
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
        // Turn death cancels its form too; only a reply is conclusive here.
        if (event.properties.disposition === "replied") noteLocalFormReplied(event.properties.formID)
        break
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
