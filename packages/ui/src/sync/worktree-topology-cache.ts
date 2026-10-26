import type { WorktreeMetadata } from "@/types/worktree"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"

const STORAGE_KEY = "oc.worktreeMap.v2"
const LEGACY_STORAGE_KEY = "oc.worktreeMap"
const MAX_RUNTIME_TOPOLOGIES = 8

type PersistedTopology = {
  updatedAt: number
  entries: Array<[string, WorktreeMetadata[]]>
}

type PersistedTopologyEnvelope = {
  version: 2
  legacyClaimed: boolean
  runtimes: Record<string, PersistedTopology>
}

const emptyEnvelope = (): PersistedTopologyEnvelope => ({ version: 2, legacyClaimed: false, runtimes: {} })

const parseEntries = (value: unknown): Array<[string, WorktreeMetadata[]]> => {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is [string, WorktreeMetadata[]] => (
    Array.isArray(entry)
    && typeof entry[0] === "string"
    && Array.isArray(entry[1])
  ))
}

const readEnvelope = (storage: Storage): PersistedTopologyEnvelope => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyEnvelope()
    const parsed = JSON.parse(raw) as Partial<PersistedTopologyEnvelope>
    if (parsed.version !== 2 || !parsed.runtimes || typeof parsed.runtimes !== "object") return emptyEnvelope()
    const runtimes: Record<string, PersistedTopology> = {}
    for (const [runtimeKey, topology] of Object.entries(parsed.runtimes)) {
      const entries = parseEntries(topology?.entries)
      if (!runtimeKey || entries.length === 0) continue
      runtimes[runtimeKey] = {
        updatedAt: typeof topology.updatedAt === "number" ? topology.updatedAt : 0,
        entries,
      }
    }
    return { version: 2, legacyClaimed: parsed.legacyClaimed === true, runtimes }
  } catch {
    return emptyEnvelope()
  }
}

const writeEnvelope = (storage: Storage, envelope: PersistedTopologyEnvelope): void => {
  const retained = Object.entries(envelope.runtimes)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RUNTIME_TOPOLOGIES)
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...envelope, runtimes: Object.fromEntries(retained) }))
}

export function readPersistedWorktreeTopology(
  runtimeKey: string,
  storage: Storage = getDeferredSafeStorage(),
): Map<string, WorktreeMetadata[]> {
  const envelope = readEnvelope(storage)
  const topology = envelope.runtimes[runtimeKey]
  if (topology) return new Map(topology.entries)
  if (envelope.legacyClaimed) return new Map()

  try {
    const legacyEntries = parseEntries(JSON.parse(storage.getItem(LEGACY_STORAGE_KEY) ?? "[]"))
    envelope.legacyClaimed = true
    if (legacyEntries.length > 0) {
      envelope.runtimes[runtimeKey] = { updatedAt: Date.now(), entries: legacyEntries }
    }
    writeEnvelope(storage, envelope)
    storage.removeItem(LEGACY_STORAGE_KEY)
    return new Map(legacyEntries)
  } catch {
    return new Map()
  }
}

export function persistWorktreeTopology(
  runtimeKey: string,
  topology: Map<string, WorktreeMetadata[]>,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!runtimeKey) return
  try {
    const envelope = readEnvelope(storage)
    envelope.legacyClaimed = true
    envelope.runtimes[runtimeKey] = {
      updatedAt: Date.now(),
      entries: [...topology.entries()],
    }
    writeEnvelope(storage, envelope)
    storage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Discovery remains authoritative in memory when persistence is unavailable.
  }
}
