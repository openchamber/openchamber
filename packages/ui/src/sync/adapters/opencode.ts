import type { Event, Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type {
  ChatSyncEvent,
  HarnessMessage,
  HarnessMessageAttribution,
  HarnessPart,
  HarnessProviderOptionSelection,
  HarnessRuntimeEvent,
  HarnessRunConfig,
  HarnessSession,
} from "@openchamber/harness-contracts"

const OPENCODE_BACKEND_ID = "opencode"

type OpenCodeModelRef = {
  providerID?: unknown
  modelID?: unknown
}

type OpenCodeMessageLike = Message & {
  sessionID?: string
  providerID?: string
  modelID?: string
  model?: OpenCodeModelRef
  agent?: string
  mode?: string
  variant?: string
  finish?: string
}

type OpenCodePartLike = Part & {
  sessionID?: string
  messageID?: string
  text?: string
  output?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    error?: unknown
    time?: {
      start?: number
      end?: number
    }
  }
  tool?: string
  callID?: string
  url?: string
  mime?: string
  filename?: string
}

export function fromOpenCodeSession(session: Session): HarnessSession {
  const source = session as Session & {
    parentID?: string | null
    directory?: string | null
    cwd?: string | null
    time?: { created?: number; updated?: number; archived?: number }
  }

  return {
    id: session.id,
    backendId: OPENCODE_BACKEND_ID,
    title: typeof session.title === "string" ? session.title : "",
    directory: source.directory ?? source.cwd ?? null,
    parentId: source.parentID ?? null,
    time: {
      created: source.time?.created ?? 0,
      updated: source.time?.updated,
      archived: source.time?.archived,
    },
    raw: session,
  }
}

export function toOpenCodeSessionCompat(session: HarnessSession): Session {
  if (isObject(session.raw)) {
    return session.raw as Session
  }

  return {
    id: session.id,
    title: session.title,
    parentID: session.parentId ?? undefined,
    time: session.time,
  } as Session
}

export function fromOpenCodeMessage(message: Message): HarnessMessage {
  const source = message as OpenCodeMessageLike
  const attribution = getMessageAttribution(source)

  return {
    id: message.id,
    sessionId: source.sessionID ?? "",
    role: getMessageRole(source.role),
    time: {
      created: message.time?.created ?? 0,
      completed: (message.time as { completed?: number } | undefined)?.completed,
    },
    finish: source.finish,
    attribution,
    raw: message,
  }
}

export function toOpenCodeMessageCompat(message: HarnessMessage): Message {
  if (isObject(message.raw)) {
    return message.raw as Message
  }

  return {
    id: message.id,
    sessionID: message.sessionId,
    role: message.role,
    time: message.time,
    finish: message.finish,
  } as Message
}

export function fromOpenCodePart(part: Part): HarnessPart {
  const source = part as OpenCodePartLike
  const base = {
    id: part.id,
    sessionId: source.sessionID ?? "",
    messageId: source.messageID ?? "",
    raw: part,
  }

  if (part.type === "text") {
    return {
      ...base,
      kind: "text",
      text: typeof source.text === "string" ? source.text : "",
    }
  }

  if (part.type === "reasoning") {
    return {
      ...base,
      kind: "reasoning",
      text: typeof source.text === "string" ? source.text : "",
    }
  }

  if (part.type === "tool") {
    return {
      ...base,
      kind: "tool",
      tool: {
        id: source.callID ?? part.id,
        name: source.tool ?? "tool",
        category: getToolCategory(source.tool),
        status: getToolStatus(source.state?.status),
        input: source.state?.input,
        output: stringifyOutput(source.state?.output),
        error: stringifyOutput(source.state?.error),
        startedAt: source.state?.time?.start,
        endedAt: source.state?.time?.end,
        raw: part,
      },
    }
  }

  if (part.type === "file") {
    return {
      ...base,
      kind: "attachment",
      attachment: {
        id: part.id,
        name: source.filename,
        mimeType: source.mime,
        url: source.url,
        raw: part,
      },
    }
  }

  return {
    ...base,
    kind: "custom",
    content: part,
  }
}

export function toOpenCodePartCompat(part: HarnessPart): Part {
  if (isObject(part.raw)) {
    return part.raw as Part
  }

  if (part.kind === "text") {
    return {
      id: part.id,
      sessionID: part.sessionId,
      messageID: part.messageId,
      type: "text",
      text: part.text,
    } as Part
  }

  if (part.kind === "reasoning") {
    return {
      id: part.id,
      sessionID: part.sessionId,
      messageID: part.messageId,
      type: "reasoning",
      text: part.text,
    } as Part
  }

  return {
    id: part.id,
    sessionID: part.sessionId,
    messageID: part.messageId,
    type: part.kind,
  } as Part
}

export function fromOpenCodeRunConfig(input: {
  backendId?: string
  providerID?: string
  modelID?: string
  agent?: string
  modeId?: string
  variant?: string
  effortId?: string
}): HarnessRunConfig {
  const options: HarnessProviderOptionSelection[] = []
  if (input.variant) options.push({ id: "variant", value: input.variant })
  if (input.effortId) options.push({ id: "effort", value: input.effortId })

  return {
    backendId: input.backendId ?? OPENCODE_BACKEND_ID,
    model: input.modelID
      ? {
          backendId: input.backendId ?? OPENCODE_BACKEND_ID,
          modelId: input.providerID ? `${input.providerID}/${input.modelID}` : input.modelID,
        }
      : undefined,
    interactionMode: input.agent ?? input.modeId,
    options: options.length > 0 ? options : undefined,
  }
}

export function fromOpenCodeEvent(event: Event): ChatSyncEvent | null {
  const runtimeEvent = fromOpenCodeRuntimeEvent(event)
  return runtimeEvent ? projectHarnessRuntimeEvent(runtimeEvent) : null
}

export function fromOpenCodeRuntimeEvent(event: Event): HarnessRuntimeEvent | null {
  const eventId = getString(event, "id") ?? `${event.type}:${Date.now()}`
  const sessionId = getSessionIdFromEvent(event)

  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const info = getProperty<Session>(event, "info")
      if (info && event.type === "session.updated" && (info as { time?: { archived?: unknown } }).time?.archived) {
        return createRuntimeEvent(event, eventId, info.id, "session.exited", { sessionId: info.id })
      }
      return info ? createRuntimeEvent(event, eventId, info.id, "thread.metadata.updated", fromOpenCodeSession(info)) : null
    }
    case "session.deleted": {
      const info = getProperty<Session>(event, "info")
      return info ? createRuntimeEvent(event, eventId, info.id, "session.exited", { sessionId: info.id }) : null
    }
    case "session.status": {
      const props = getProperties(event)
      const id = getString(props, "sessionID")
      return id ? createRuntimeEvent(event, eventId, id, "session.state.changed", {
        sessionId: id,
        status: normalizeOpenCodeSessionStatus(props.status),
        rawStatus: props.status,
      }) : null
    }
    case "session.idle":
    case "session.error": {
      return sessionId ? createRuntimeEvent(event, eventId, sessionId, "session.state.changed", {
        sessionId,
        status: event.type === "session.error" ? "error" : "idle",
      }) : null
    }
    case "message.updated": {
      const info = getProperty<Message>(event, "info")
      return info ? createRuntimeEvent(event, eventId, (info as { sessionID?: string }).sessionID ?? "", "item.updated", fromOpenCodeMessage(info)) : null
    }
    case "message.removed": {
      const props = getProperties(event)
      const sessionId = getString(props, "sessionID")
      const messageId = getString(props, "messageID")
      return sessionId && messageId ? createRuntimeEvent(event, eventId, sessionId, "item.completed", { removed: true, sessionId, messageId }) : null
    }
    case "message.part.updated": {
      const part = getProperty<Part>(event, "part")
      return part ? createRuntimeEvent(event, eventId, (part as { sessionID?: string }).sessionID ?? "", "item.updated", fromOpenCodePart(part)) : null
    }
    case "message.part.removed": {
      const props = getProperties(event)
      const sessionId = getString(props, "sessionID") ?? ""
      const messageId = getString(props, "messageID")
      const partId = getString(props, "partID")
      return messageId && partId ? createRuntimeEvent(event, eventId, sessionId, "item.completed", { removed: true, sessionId, messageId, partId }) : null
    }
    case "message.part.delta": {
      const props = getProperties(event)
      const messageId = getString(props, "messageID")
      const partId = getString(props, "partID")
      const field = getString(props, "field")
      const delta = getString(props, "delta")
      if (!messageId || !partId || !field || delta === undefined) return null
      return createRuntimeEvent(event, eventId, getString(props, "sessionID") ?? "", "content.delta", {
        sessionId: getString(props, "sessionID") ?? "",
        messageId,
        partId,
        field,
        delta,
      })
    }
    default:
      return null
  }
}

export function projectHarnessRuntimeEvent(event: HarnessRuntimeEvent): ChatSyncEvent | null {
  switch (event.type) {
    case "thread.metadata.updated": {
      return isHarnessSessionPayload(event.payload) ? { type: "session.upserted", session: event.payload } : null
    }
    case "session.exited": {
      const sessionId = getString(event.payload, "sessionId")
      return sessionId ? { type: "session.removed", sessionId } : null
    }
    case "session.state.changed": {
      const sessionId = getString(event.payload, "sessionId") ?? event.sessionId
      const status = getString(event.payload, "status")
      const rawStatus = isObject(event.payload) ? event.payload.rawStatus : undefined
      return sessionId && status
        ? { type: "session.status.updated", sessionId, status: { sessionId, backendId: event.backendId, status: status === "error" ? "error" : status === "running" ? "running" : "idle", raw: rawStatus } }
        : null
    }
    case "item.updated": {
      if (isHarnessMessagePayload(event.payload)) return { type: "message.upserted", message: event.payload }
      if (isHarnessPartPayload(event.payload)) return { type: "part.upserted", part: event.payload }
      return null
    }
    case "item.completed": {
      const sessionId = getString(event.payload, "sessionId") ?? event.sessionId
      const messageId = getString(event.payload, "messageId")
      const partId = getString(event.payload, "partId")
      if (messageId && partId) return { type: "part.removed", sessionId, messageId, partId }
      if (messageId) return { type: "message.removed", sessionId, messageId }
      return null
    }
    case "content.delta": {
      const sessionId = getString(event.payload, "sessionId") ?? event.sessionId
      const messageId = getString(event.payload, "messageId")
      const partId = getString(event.payload, "partId")
      const field = getString(event.payload, "field")
      const delta = getString(event.payload, "delta")
      return messageId && partId && field && delta !== undefined
        ? { type: "part.delta", sessionId, messageId, partId, field, delta }
        : null
    }
    default:
      return null
  }
}

function createRuntimeEvent(
  event: Event,
  eventId: string,
  sessionId: string,
  type: HarnessRuntimeEvent["type"],
  payload: unknown,
): HarnessRuntimeEvent {
  return {
    eventId,
    backendId: OPENCODE_BACKEND_ID,
    sessionId,
    createdAt: new Date().toISOString(),
    type,
    payload,
    raw: {
      source: OPENCODE_BACKEND_ID,
      messageType: event.type,
      payload: event,
    },
  }
}

function getMessageAttribution(message: OpenCodeMessageLike): HarnessMessageAttribution | undefined {
  const providerId = getString(message, "providerID") ?? getString(message.model, "providerID")
  const modelId = getString(message, "modelID") ?? getString(message.model, "modelID")
  const modeId = getString(message, "agent") ?? getString(message, "mode")
  const effortId = getString(message, "variant")

  if (!providerId && !modelId && !modeId && !effortId) return undefined

  return {
    backendId: OPENCODE_BACKEND_ID,
    providerId,
    modelId,
    modeId,
    effortId,
  }
}

function getSessionIdFromEvent(event: Event): string {
  const props = getProperties(event)
  const direct = getString(props, "sessionID")
  if (direct) return direct
  const info = props.info
  if (isObject(info)) return getString(info, "id") ?? getString(info, "sessionID") ?? ""
  const part = props.part
  if (isObject(part)) return getString(part, "sessionID") ?? ""
  return ""
}

function normalizeOpenCodeSessionStatus(status: unknown): string {
  if (typeof status === "string") return status
  if (!isObject(status)) return "idle"
  const type = status.type
  if (type === "busy" || type === "running") return "running"
  if (type === "error") return "error"
  return "idle"
}

function isHarnessSessionPayload(value: unknown): value is HarnessSession {
  return isObject(value) && typeof value.id === "string" && typeof value.backendId === "string" && typeof value.title === "string"
}

function isHarnessMessagePayload(value: unknown): value is HarnessMessage {
  return isObject(value) && typeof value.id === "string" && typeof value.sessionId === "string" && typeof value.role === "string"
}

function isHarnessPartPayload(value: unknown): value is HarnessPart {
  return isObject(value) && typeof value.id === "string" && typeof value.messageId === "string" && typeof value.kind === "string"
}

function getMessageRole(role: unknown) {
  if (role === "assistant" || role === "system") return role
  return "user"
}

function getToolCategory(name: string | undefined) {
  if (!name) return "custom"
  if (["bash", "shell", "cmd", "terminal"].includes(name)) return "shell"
  if (["edit", "write", "apply_patch", "patch", "str_replace"].includes(name)) return "edit"
  if (["grep", "glob", "search"].includes(name)) return "search"
  if (["webfetch", "fetch"].includes(name)) return "fetch"
  if (name === "task") return "task"
  return "custom"
}

function getToolStatus(status: string | undefined) {
  if (status === "running") return "running"
  if (status === "completed") return "completed"
  if (["error", "failed", "timeout"].includes(status ?? "")) return "failed"
  if (["cancelled", "aborted"].includes(status ?? "")) return "cancelled"
  return "pending"
}

function stringifyOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return undefined
  return JSON.stringify(value)
}

function getProperty<T>(event: Event, key: string): T | undefined {
  const props = getProperties(event)
  return props[key] as T | undefined
}

function getProperties(event: Event): Record<string, unknown> {
  return isObject((event as { properties?: unknown }).properties) ? (event as { properties: Record<string, unknown> }).properties : {}
}

function getString(source: unknown, key: string): string | undefined {
  if (!isObject(source)) return undefined
  const value = source[key]
  return typeof value === "string" ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
