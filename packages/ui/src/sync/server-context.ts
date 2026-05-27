import { create } from "zustand"
import { useCallback, useMemo } from "react"
import { useStore } from "zustand"
import { toast } from "@/components/ui"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getSyncChildStores } from "./sync-refs"

export interface ServerInfo {
  id: string
  label: string
  type: "local" | "ssh" | "remote-url"
  status: "connecting" | "connected" | "disconnected" | "error"
  errorMessage?: string
  url: string
}

interface ServerState {
  servers: ServerInfo[]
  status: "idle" | "loading" | "ready" | "error"

  setServers: (servers: ServerInfo[]) => void
  upsertServer: (server: ServerInfo) => void
  setLoading: (loading: boolean) => void
  setError: (error: boolean) => void
}

export const useServerStore = create<ServerState>()((set) => ({
  servers: [],
  status: "idle",
  setServers: (servers) => set({ servers, status: "ready" }),
  upsertServer: (server) =>
    set((state) => {
      const next = [...state.servers]
      const index = next.findIndex((s) => s.id === server.id)
      if (index >= 0) {
        next[index] = server
      } else {
        next.push(server)
      }
      return { servers: next }
    }),
  setLoading: (loading) => set((state) => ({ status: loading ? "loading" : (state.status === "error" ? "error" : "ready") })),
  setError: (error) => set({ status: error ? "error" : "ready" }),
}))

export class ServerRegistrationError extends Error {
  constructor(
    public readonly status: number,
    body: unknown,
  ) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Server registration failed (${status})`
    super(message)
    this.name = "ServerRegistrationError"
  }
}

export async function fetchServerList(): Promise<ServerInfo[]> {
  const response = await fetch("/api/servers")
  if (!response.ok) {
    throw new Error("Failed to fetch server list")
  }
  return response.json()
}

const pendingRegistration = new Map<string, AbortController>()

export async function registerServer(
  config: Omit<ServerInfo, "status">,
  signal?: AbortSignal,
): Promise<ServerInfo> {
  pendingRegistration.get(config.id)?.abort()
  const controller = new AbortController()
  pendingRegistration.set(config.id, controller)
  try {
    const response = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      signal: signal ?? controller.signal,
    })
    if (!response.ok) {
      throw new ServerRegistrationError(response.status, await response.json())
    }
    return response.json()
  } finally {
    if (pendingRegistration.get(config.id) === controller) {
      pendingRegistration.delete(config.id)
    }
  }
}

export async function unregisterServer(serverId: string): Promise<void> {
  const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Failed to unregister server (${response.status})`
    throw new Error(message)
  }
}

export function useServerList(): ServerInfo[] {
  return useStore(useServerStore, useCallback((s) => s.servers, []))
}

export function useActiveServerId(): string {
  return useStore(useDirectoryStore, useCallback((s) => s.currentServerId, []))
}

export function useServerActions() {
  const upsertServer = useServerStore(useCallback((s) => s.upsertServer, []))
  const setServers = useServerStore(useCallback((s) => s.setServers, []))
  const setError = useServerStore(useCallback((s) => s.setError, []))
  const setLoading = useServerStore(useCallback((s) => s.setLoading, []))

  const connectServer = useCallback(
    async (id: string, label: string, type: string, url: string) => {
      setLoading(true)
      try {
        const server = await registerServer({ id, label, type: type as ServerInfo["type"], url })
        upsertServer(server)
        return server
      } catch (error) {
        setError(true)
        const message = error instanceof Error ? error.message : String(error)
        toast.error(message)
        throw error
      } finally {
        setLoading(false)
      }
    },
    [upsertServer, setError, setLoading],
  )

  const disconnectServer = useCallback(
    async (id: string) => {
      setLoading(true)
      try {
        await unregisterServer(id)
        try {
          getSyncChildStores().removeAllForServer(id)
        } catch { /* childStores may not be initialized yet */ }
        useGlobalSessionsStore.getState().removeServerEntries(id)
        setServers(useServerStore.getState().servers.filter((s) => s.id !== id))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast.error(message)
      } finally {
        setLoading(false)
      }
    },
    [setServers, setLoading],
  )

  return useMemo(() => ({ connectServer, disconnectServer }), [connectServer, disconnectServer])
}

export function useServerStatus(): ServerState["status"] {
  return useStore(useServerStore, useCallback((s) => s.status, []))
}
