
import type { PluginInfo } from "@opencode/client"
import { normalizeOpencodeError, opencodeClient, type OpenCodeClient } from "./client"

export type PluginRuntimeSource =
  | { kind: "package"; target: string; version: string | null; outdated: boolean; updating: boolean }
  | { kind: "local"; path: string }
  | { kind: "builtin" }

export type PluginRuntimeState = { kind: "active" } | { kind: "failed"; error: string; ref: string | null }

export interface PluginRuntimeInfo {
  source: PluginRuntimeSource
  state: PluginRuntimeState
}

const clientFor = (directory: string | null): OpenCodeClient =>
  directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient()

const toSource = (source: PluginInfo["source"]): PluginRuntimeSource => {
  switch (source.type) {
    case "package":
      return {
        kind: "package",
        target: source.target,
        version: source.version ?? null,
        outdated: source.outdated === true,
        updating: source.updating === true,
      }
    case "local":
      return { kind: "local", path: source.path }
    case "builtin":
    case "sdk":
      return { kind: "builtin" }
  }
}

const toState = (state: PluginInfo["state"]): PluginRuntimeState =>
  state.status === "active" ? { kind: "active" } : { kind: "failed", error: state.error, ref: state.ref ?? null }

const toRuntimeInfo = (info: PluginInfo): PluginRuntimeInfo => ({ source: toSource(info.source), state: toState(info.state) })

async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw normalizeOpencodeError(operation, error)
  }
}

export async function listPluginRuntime(directory: string | null): Promise<PluginRuntimeInfo[]> {
  const response = await call("plugin.list", () => clientFor(directory).plugin.list())
  return response.data.map(toRuntimeInfo)
}

export async function checkPluginUpdates(directory: string | null): Promise<PluginRuntimeInfo[]> {
  const response = await call("plugin.check", () => clientFor(directory).plugin.check())
  return response.data.map(toRuntimeInfo)
}

export async function updatePluginPackage(directory: string | null, target: string): Promise<void> {
  await call("plugin.update", () => clientFor(directory).plugin.update({ targets: [target] }))
}
