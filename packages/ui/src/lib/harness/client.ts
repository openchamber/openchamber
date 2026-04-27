import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import type {
  AbortHarnessSessionInput,
  CreateHarnessSessionInput,
  ForkHarnessSessionInput,
  HarnessAttachment,
  HarnessProviderOptionSelection,
  HarnessRunConfig,
  HarnessSession,
  SendHarnessCommandInput,
  SendHarnessMessageInput,
} from "@openchamber/harness-contracts"
import { opencodeClient } from "@/lib/opencode/client"
import { fromOpenCodeRunConfig, fromOpenCodeSession } from "@/sync/adapters/opencode"

type OpenCodeRunConfigInput = {
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
  createSession(input: CreateHarnessSessionInput): Promise<HarnessSession>
  sendMessage(input: HarnessSendMessageInput): Promise<void>
  sendCommand(input: HarnessSendCommandInput): Promise<void>
  abortSession(input: AbortHarnessSessionInput): Promise<void>
  archiveSession(sessionId: string, archivedAt: number, directory?: string | null): Promise<HarnessSession>
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

  async sendMessage(input: HarnessSendMessageInput): Promise<void> {
    const runConfig = getOpenCodeRunConfig(input)
    await this.withDirectory(input.directory, () => opencodeClient.sendMessage({
      id: input.sessionId,
      text: input.text,
      providerID: runConfig.providerID,
      modelID: runConfig.modelID,
      agent: runConfig.agent,
      variant: runConfig.variant,
      files: input.files ?? input.attachments?.map(toFileInput).filter((file) => file !== null) ?? undefined,
      additionalParts: input.additionalParts,
      messageId: input.messageId,
      format: input.format as Parameters<typeof opencodeClient.sendMessage>[0]["format"],
      sandboxOverride: input.sandboxOverride,
    }))
  }

  async sendCommand(input: HarnessSendCommandInput): Promise<void> {
    const runConfig = getOpenCodeRunConfig(input)
    await this.withDirectory(input.directory, () => opencodeClient.sendCommand({
      id: input.sessionId,
      providerID: runConfig.providerID,
      modelID: runConfig.modelID,
      command: input.commandId,
      arguments: input.arguments,
      agent: runConfig.agent,
      variant: runConfig.variant,
      files: input.files,
      messageId: input.messageId,
    }))
  }

  async abortSession(input: AbortHarnessSessionInput): Promise<void> {
    await this.withDirectory(input.directory, () => opencodeClient.abortSession(input.sessionId))
  }

  async archiveSession(sessionId: string, archivedAt: number, directory?: string | null): Promise<HarnessSession> {
    return this.withDirectory(directory, async () => {
      const session = await opencodeClient.archiveSession(sessionId, archivedAt)
      return toHarnessSession(session as Session)
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
}

function getOpenCodeRunConfig(input: { runConfig?: HarnessRunConfig }): OpenCodeRunConfigInput & { providerID: string; modelID: string } {
  const runConfig = input.runConfig
  const legacy = (runConfig as HarnessRunConfig & { raw?: OpenCodeRunConfigInput } | undefined)?.raw
  const modelId = runConfig?.model?.modelId
  const slashIndex = typeof modelId === "string" ? modelId.indexOf("/") : -1
  return {
    providerID: legacy?.providerID ?? (slashIndex > 0 && modelId ? modelId.slice(0, slashIndex) : ""),
    modelID: legacy?.modelID ?? (slashIndex > 0 && modelId ? modelId.slice(slashIndex + 1) : modelId ?? ""),
    agent: runConfig?.interactionMode ?? legacy?.agent ?? undefined,
    variant: getOptionValue(runConfig?.options, "variant") ?? legacy?.variant ?? undefined,
  }
}

function getOptionValue(options: HarnessProviderOptionSelection[] | undefined, id: string): string | undefined {
  const option = options?.find((candidate) => candidate.id === id)
  return typeof option?.value === "string" ? option.value : undefined
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
      backendId: "opencode",
      providerID: input.providerID,
      modelID: input.modelID,
      agent: input.agent,
      variant: input.variant,
    }),
    raw: input,
  }
}

export const harnessClient: HarnessClient = new OpenChamberHarnessClient()
