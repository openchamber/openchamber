import type { OpenCodeClient } from "@opencode/client"

type FolderAgentReader = Pick<OpenCodeClient, "agent" | "model">
type WireAgent = Awaited<ReturnType<OpenCodeClient["agent"]["list"]>>["data"][number]

export const readFolderAgents = async (client: FolderAgentReader, isCurrentRuntime: () => boolean): Promise<WireAgent[]> => {
  const agents = (await client.agent.list()).data
  if (agents.length > 0) return agents
  await client.model.default().catch(() => undefined)
  if (!isCurrentRuntime()) throw new Error("Runtime instance changed")
  return (await client.agent.list()).data
}
