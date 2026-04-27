import type { Event, Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type {
  ChatSyncEvent,
  HarnessMessage,
  HarnessMessageAttribution,
  HarnessPart,
  HarnessProviderOptionSelection,
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
  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const info = getProperty<Session>(event, "info")
      return info ? { type: "session.upserted", session: fromOpenCodeSession(info) } : null
    }
    case "session.deleted": {
      const info = getProperty<Session>(event, "info")
      return info ? { type: "session.removed", sessionId: info.id } : null
    }
    case "message.updated": {
      const info = getProperty<Message>(event, "info")
      return info ? { type: "message.upserted", message: fromOpenCodeMessage(info) } : null
    }
    case "message.removed": {
      const props = getProperties(event)
      const sessionId = getString(props, "sessionID")
      const messageId = getString(props, "messageID")
      return sessionId && messageId ? { type: "message.removed", sessionId, messageId } : null
    }
    case "message.part.updated": {
      const part = getProperty<Part>(event, "part")
      return part ? { type: "part.upserted", part: fromOpenCodePart(part) } : null
    }
    case "message.part.removed": {
      const props = getProperties(event)
      const sessionId = getString(props, "sessionID") ?? ""
      const messageId = getString(props, "messageID")
      const partId = getString(props, "partID")
      return messageId && partId ? { type: "part.removed", sessionId, messageId, partId } : null
    }
    case "message.part.delta": {
      const props = getProperties(event)
      const messageId = getString(props, "messageID")
      const partId = getString(props, "partID")
      const field = getString(props, "field")
      const delta = getString(props, "delta")
      if (!messageId || !partId || !field || delta === undefined) return null
      return { type: "part.delta", sessionId: getString(props, "sessionID") ?? "", messageId, partId, field, delta }
    }
    default:
      return null
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
