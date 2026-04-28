import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import type {
  AbortHarnessSessionInput,
  CreateHarnessSessionInput,
  ForkHarnessSessionInput,
  HarnessAttachment,
  HarnessSession,
  SendHarnessCommandInput,
  SendHarnessMessageInput,
} from "@openchamber/harness-contracts"
import { opencodeClient } from "@/lib/opencode/client"
import { fromOpenCodeRunConfig, fromOpenCodeSession } from "@/sync/adapters/opencode"

type OpenCodeRunConfigInput = {
  backendId?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
}

type HarnessSendMessageInput = SendHarnessMessageInput & {
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  additionalParts?: Array<{ text: string; synthetic?: boolean; files?: Array<{ type: "file"; mime: string; url: string; filename: string }> }>
  format?: unknown
  sandboxOverride?: string
}

type HarnessSendCommandInput = SendHarnessCommandInput & {
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
}

export type HarnessClient = {
  getDirectory(): string | undefined
  setDirectory(directory?: string | null): void
  getSdkClient(): OpencodeClient
  getScopedSdkClient(directory: string): OpencodeClient
  listSessions(input?: { backendId?: string; directory?: string | null; limit?: number; archived?: boolean; roots?: boolean }): Promise<HarnessSession[]>
  getSession(sessionId: string, directory?: string | null): Promise<HarnessSession>
  getMessages(input: { sessionId: string; directory?: string | null; limit?: number; before?: string }): Promise<Array<{ info: Message; parts: Part[] }>>
  createSession(input: CreateHarnessSessionInput): Promise<HarnessSession>
  deleteSession(input: { sessionId: string; directory?: string | null }): Promise<boolean>
  sendMessage(input: HarnessSendMessageInput): Promise<void>
  sendCommand(input: HarnessSendCommandInput): Promise<void>
  abortSession(input: AbortHarnessSessionInput): Promise<void>
  updateSession(input: { sessionId: string; directory?: string | null; title?: string; time?: { archived?: number } }): Promise<HarnessSession>
  archiveSession(sessionId: string, archivedAt: number, directory?: string | null): Promise<HarnessSession>
  shareSession(sessionId: string, directory?: string | null): Promise<HarnessSession>
  unshareSession(sessionId: string, directory?: string | null): Promise<HarnessSession>
  revertSession(input: { sessionId: string; messageId: string; partId?: string; directory?: string | null }): Promise<HarnessSession>
  unrevertSession(input: { sessionId: string; directory?: string | null }): Promise<HarnessSession>
  replyToBlockingRequest(input: { sessionId: string; requestId: string; kind: "permission" | "question"; directory?: string | null; reply?: string; answers?: unknown }): Promise<void>
  rejectBlockingRequest(input: { sessionId: string; requestId: string; kind: "permission" | "question"; directory?: string | null }): Promise<void>
  forkSession(input: ForkHarnessSessionInput): Promise<HarnessSession>
}

class OpenChamberHarnessClient implements HarnessClient {
  getDirectory(): string | undefined {
    return opencodeClient.getDirectory()
  }

  setDirectory(directory?: string | null): void {
    opencodeClient.setDirectory(directory ?? undefined)
  }

  getSdkClient(): OpencodeClient {
    return opencodeClient.getSdkClient()
  }

  getScopedSdkClient(directory: string): OpencodeClient {
    return opencodeClient.getScopedSdkClient(directory)
  }

  async listSessions(input: { backendId?: string; directory?: string | null; limit?: number; archived?: boolean; roots?: boolean } = {}): Promise<HarnessSession[]> {
    const url = this.getHarnessUrl("/sessions")
    if (input.backendId) url.searchParams.set("backendId", input.backendId)
    if (input.directory) url.searchParams.set("directory", input.directory)
    if (typeof input.limit === "number") url.searchParams.set("limit", String(input.limit))
    if (typeof input.archived === "boolean") url.searchParams.set("archived", String(input.archived))
    if (typeof input.roots === "boolean") url.searchParams.set("roots", String(input.roots))
    const payload = await this.fetchJson(url)
    return Array.isArray(payload) ? payload.map((session) => toHarnessSession(session as Session)) : []
  }

  async getSession(sessionId: string, directory?: string | null): Promise<HarnessSession> {
    const url = this.getHarnessUrl(`/session/${encodeURIComponent(sessionId)}`)
    if (directory) url.searchParams.set("directory", directory)
    return toHarnessSession(await this.fetchJson(url) as Session)
  }

  async getMessages(input: { sessionId: string; directory?: string | null; limit?: number; before?: string }): Promise<Array<{ info: Message; parts: Part[] }>> {
    const url = this.getHarnessUrl(`/session/${encodeURIComponent(input.sessionId)}/messages`)
    if (input.directory) url.searchParams.set("directory", input.directory)
    if (typeof input.limit === "number") url.searchParams.set("limit", String(input.limit))
    if (input.before) url.searchParams.set("before", input.before)
    const payload = await this.fetchJson(url)
    return Array.isArray(payload) ? payload as Array<{ info: Message; parts: Part[] }> : []
  }

  async createSession(input: CreateHarnessSessionInput): Promise<HarnessSession> {
    return this.withDirectory(input.directory, async () => {
      const session = await opencodeClient.createSession({
        title: input.title,
        parentID: input.parentId ?? undefined,
        backendId: input.backendId,
      })
      return toHarnessSession(session as Session)
    })
  }

  async deleteSession(input: { sessionId: string; directory?: string | null }): Promise<boolean> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}`, {
      method: "DELETE",
      body: { directory: input.directory },
    }) as { ok?: unknown } | null
    return payload?.ok === true
  }

  async sendMessage(input: HarnessSendMessageInput): Promise<void> {
    const parts = await this.buildMessageParts(input)
    await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/message`, {
      method: "POST",
      body: {
        directory: input.directory,
        runConfig: input.runConfig,
        messageId: input.messageId,
        format: input.format,
        sandboxOverride: input.sandboxOverride,
        parts,
      },
      emptyOk: true,
    })
  }

  async sendCommand(input: HarnessSendCommandInput): Promise<void> {
    await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/command`, {
      method: "POST",
      body: {
        directory: input.directory,
        runConfig: input.runConfig,
        commandId: input.commandId,
        arguments: input.arguments,
        messageId: input.messageId,
        parts: input.files,
      },
    })
  }

  async abortSession(input: AbortHarnessSessionInput): Promise<void> {
    await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/abort`, {
      method: "POST",
      body: { directory: input.directory },
      emptyOk: true,
    })
  }

  async updateSession(input: { sessionId: string; directory?: string | null; title?: string; time?: { archived?: number } }): Promise<HarnessSession> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/update`, {
      method: "POST",
      body: {
        directory: input.directory,
        title: input.title,
        time: input.time,
      },
    })
    return payload as HarnessSession
  }

  async archiveSession(sessionId: string, archivedAt: number, directory?: string | null): Promise<HarnessSession> {
    return this.updateSession({ sessionId, directory, time: { archived: archivedAt } })
  }

  async shareSession(sessionId: string, directory?: string | null): Promise<HarnessSession> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(sessionId)}/share`, {
      method: "POST",
      body: { directory },
    })
    return payload as HarnessSession
  }

  async unshareSession(sessionId: string, directory?: string | null): Promise<HarnessSession> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(sessionId)}/unshare`, {
      method: "POST",
      body: { directory },
    })
    return payload as HarnessSession
  }

  async revertSession(input: { sessionId: string; messageId: string; partId?: string; directory?: string | null }): Promise<HarnessSession> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/revert`, {
      method: "POST",
      body: {
        directory: input.directory,
        messageId: input.messageId,
        partId: input.partId,
      },
    })
    return payload as HarnessSession
  }

  async unrevertSession(input: { sessionId: string; directory?: string | null }): Promise<HarnessSession> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/unrevert`, {
      method: "POST",
      body: { directory: input.directory },
    })
    return payload as HarnessSession
  }

  async replyToBlockingRequest(input: { sessionId: string; requestId: string; kind: "permission" | "question"; directory?: string | null; reply?: string; answers?: unknown }): Promise<void> {
    await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/blocking-request/${encodeURIComponent(input.requestId)}/reply`, {
      method: "POST",
      body: {
        kind: input.kind,
        directory: input.directory,
        reply: input.reply,
        answers: input.answers,
      },
    })
  }

  async rejectBlockingRequest(input: { sessionId: string; requestId: string; kind: "permission" | "question"; directory?: string | null }): Promise<void> {
    await this.fetchJson(`/session/${encodeURIComponent(input.sessionId)}/blocking-request/${encodeURIComponent(input.requestId)}/reject`, {
      method: "POST",
      body: {
        kind: input.kind,
        directory: input.directory,
      },
    })
  }

  async forkSession(input: ForkHarnessSessionInput): Promise<HarnessSession> {
    return this.withDirectory(input.directory, async () => {
      const session = await opencodeClient.forkSession(input.sessionId, input.messageId)
      return toHarnessSession(session as Session)
    })
  }

  private async withDirectory<T>(directory: string | null | undefined, run: () => Promise<T>): Promise<T> {
    const previousDirectory = opencodeClient.getDirectory()
    if (directory) {
      opencodeClient.setDirectory(directory)
    }
    try {
      return await run()
    } finally {
      opencodeClient.setDirectory(previousDirectory)
    }
  }

  private getHarnessUrl(pathname: string): URL {
    const baseUrl = (opencodeClient as unknown as { baseUrl?: string }).baseUrl ?? "/api"
    const base = baseUrl.replace(/\/+$/, "")
    return new URL(`${base}/openchamber/harness${pathname}`, window.location.origin)
  }

  private async fetchJson(input: string | URL, options: { method?: string; body?: Record<string, unknown>; emptyOk?: boolean } = {}): Promise<unknown> {
    const url = typeof input === "string" ? this.getHarnessUrl(input) : input
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null
      const message = typeof payload?.error === "string" ? payload.error : `Harness request failed (${response.status})`
      throw new Error(message)
    }
    if (options.emptyOk || response.status === 204) return null
    return response.json()
  }

  private async buildMessageParts(input: HarnessSendMessageInput): Promise<unknown[]> {
    const parts: unknown[] = []
    if (input.text?.trim()) parts.push({ type: "text", text: input.text })
    const files = input.files ?? input.attachments?.map(toFileInput).filter((file) => file !== null) ?? []
    parts.push(...files)
    for (const additional of input.additionalParts ?? []) {
      if (additional.text?.trim()) parts.push({ type: "text", text: additional.text, ...(additional.synthetic ? { synthetic: true } : {}) })
      parts.push(...(additional.files ?? []))
    }
    if (parts.length === 0) throw new Error("Message must have at least one part")
    return parts
  }
}

function toFileInput(attachment: HarnessAttachment): { type: "file"; mime: string; url: string; filename: string } | null {
  if (!attachment.url) return null
  return {
    type: "file",
    mime: attachment.mimeType ?? "application/octet-stream",
    url: attachment.url,
    filename: attachment.name ?? attachment.path ?? attachment.id ?? "attachment",
  }
}

function toHarnessSession(session: Session): HarnessSession {
  const converted = fromOpenCodeSession(session)
  const backendId = (session as Session & { backendId?: unknown }).backendId
  return typeof backendId === "string" && backendId.trim().length > 0
    ? { ...converted, backendId: backendId.trim() }
    : converted
}

export function toOpenCodeHarnessRunConfig(input: OpenCodeRunConfigInput) {
  return {
    ...fromOpenCodeRunConfig({
      backendId: input.backendId ?? "opencode",
      providerID: input.providerID,
      modelID: input.modelID,
      agent: input.agent,
      variant: input.variant,
    }),
    raw: input,
  }
}

export const harnessClient: HarnessClient = new OpenChamberHarnessClient()
