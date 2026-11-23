import type { OpenCodeClient } from "@opencode/client"

import { waitForLocationPlugins } from "./location-plugins"

type FolderAgentReader = Pick<OpenCodeClient, "agent" | "plugin">
type WireAgent = Awaited<ReturnType<OpenCodeClient["agent"]["list"]>>["data"][number]

export const readFolderAgents = async (client: FolderAgentReader, isCurrentRuntime: () => boolean): Promise<WireAgent[]> => {
  const agents = (await client.agent.list()).data
  if (agents.length > 0) return agents
  await waitForLocationPlugins(client, isCurrentRuntime)
  if (!isCurrentRuntime()) throw new Error("Runtime instance changed")
  return (await client.agent.list()).data
}
