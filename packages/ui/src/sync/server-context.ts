import { create } from "zustand"
import { useCallback, useEffect, useMemo } from "react"
import { useStore } from "zustand"
import { toast } from "@/components/ui"
import { useDirectoryStore, setServerExistsValidator } from "@/stores/useDirectoryStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getSyncChildStores, cleanRoutingIndex } from "./sync-refs"
import { getSafeStorage } from "@/stores/utils/safeStorage"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { opencodeClient } from "@/lib/opencode/client"

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
  loadingServers: Set<string>

  setServers: (servers: ServerInfo[]) => void
  upsertServer: (server: ServerInfo) => void
  setLoading: (loading: boolean) => void
  setError: (error: boolean) => void
  setServerLoading: (id: string, loading: boolean) => void
}

export const useServerStore = create<ServerState>()((set) => ({
  servers: [],
  status: "idle",
  loadingServers: new Set(),
  setServers: (servers) => set({ servers, status: "ready" }),
  upsertServer: (server) =>
    set((state) => {
      const existing = state.servers.find((s) => s.id === server.id)
      if (existing) {
        if (existing.status === server.status && existing.errorMessage === server.errorMessage
            && existing.label === server.label && existing.type === server.type && existing.url === server.url) {
          return state
        }
      }
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
  setServerLoading: (id, loading) =>
    set((state) => {
      if (loading === state.loadingServers.has(id)) return state
      const next = new Set(state.loadingServers)
      if (loading) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return { loadingServers: next }
    }),
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
  const response = await runtimeFetch("/api/servers")
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
  setTimeout(() => {
    if (pendingRegistration.get(config.id) === controller) {
      pendingRegistration.delete(config.id)
    }
  }, 30000)
  try {
    const response = await runtimeFetch("/api/servers", {
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
  const response = await runtimeFetch(`/api/servers/${encodeURIComponent(serverId)}`, {
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
  const setError = useServerStore(useCallback((s) => s.setError, []))
  const setServerLoading = useServerStore(useCallback((s) => s.setServerLoading, []))

  const connectServer = useCallback(
    async (id: string, label: string, type: string, url: string) => {
      if (useServerStore.getState().loadingServers.has(id)) {
        return undefined
      }
      setServerLoading(id, true)
      try {
        const server = await registerServer({ id, label, type: type as ServerInfo["type"], url })
        upsertServer(server)
        setError(false)
        return server
      } catch (error) {
        setError(true)
        const message = error instanceof Error ? error.message : String(error)
        toast.error(message)
        throw error
      } finally {
        setServerLoading(id, false)
      }
    },
    [upsertServer, setError, setServerLoading],
  )

  const disconnectServer = useCallback(
    async (id: string) => {
      setServerLoading(id, true)
      let apiFailed = false
      try {
        await unregisterServer(id)
      } catch (error) {
        apiFailed = true
        const message = error instanceof Error ? error.message : String(error)
        toast.error(message)
      }
      if (!apiFailed) {
        try {
          getSyncChildStores().removeAllForServer(id)
        } catch { /* childStores may not be initialized yet */ }
        try { cleanRoutingIndex() } catch { /* routing index may not be initialized */ }
        opencodeClient.clearServerClientCache(id)
        useGlobalSessionsStore.getState().removeServerEntries(id)
        const { currentServerId, setDirectory, currentDirectory } = useDirectoryStore.getState()
        if (currentServerId === id) {
          toast.info(`Switched to local server (disconnected "${id}")`)
          setDirectory(currentDirectory, { serverId: 'local' })
        }
        useServerStore.getState().setServers(useServerStore.getState().servers.filter((s) => s.id !== id))
        try {
          const storage = getSafeStorage()
          const raw = storage.getItem('oc.sessions.serverCollapse')
          if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
              storage.setItem('oc.sessions.serverCollapse', JSON.stringify(parsed.filter((item) => item !== id)))
            }
          }
        } catch { /* ignore storage cleanup errors */ }
      }
      setServerLoading(id, false)
    },
    [setServerLoading],
  )

  return useMemo(() => ({ connectServer, disconnectServer }), [connectServer, disconnectServer])
}

export function useServerStatus(): ServerState["status"] {
  return useStore(useServerStore, useCallback((s) => s.status, []))
}

let _validatorRefCount = 0

export function useInitServerExistsValidator() {
  useEffect(() => {
    _validatorRefCount++
    setServerExistsValidator((serverId: string) =>
      useServerStore.getState().servers.some((s) => s.id === serverId)
    )
    return () => {
      _validatorRefCount = Math.max(0, _validatorRefCount - 1)
      if (_validatorRefCount === 0) setServerExistsValidator(() => false)
    }
  }, [])
}
