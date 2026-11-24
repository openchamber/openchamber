import type { JsonValue, Metadata } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { retry } from "./retry"

const isMetadataRecord = (value: JsonValue | undefined): value is Metadata =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)

// external: https://www.rfc-editor.org/rfc/rfc7386 Metadata merge patches delete keys with null and preserve untouched nested siblings.
export function buildMetadataMergePatch(current: Metadata, next: Metadata): Metadata {
  const patch: Metadata = {}
  for (const key of Object.keys(current)) {
    if (!(key in next)) patch[key] = null
  }
  for (const [key, value] of Object.entries(next)) {
    const previous = current[key]
    if (isMetadataRecord(value) && isMetadataRecord(previous)) {
      const nested = buildMetadataMergePatch(previous, value)
      if (Object.keys(nested).length > 0) patch[key] = nested
      continue
    }
    if (JSON.stringify(previous) !== JSON.stringify(value)) patch[key] = value
  }
  return patch
}

export async function readForkMessages(sessionId: string, directory: string | null | undefined, isStale: () => boolean) {
  const messages: Array<{ id: string; role: string; createdAt: number }> = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await retry(() => {
      if (isStale()) throw new Error("runtime changed")
      return opencodeClient.getSessionMessages(sessionId, { limit: 100, cursor, order: "asc" }, directory)
    }, { attempts: 2 })
    if (isStale()) throw new Error("runtime changed")
    for (const { info } of page.items) {
      messages.push({ id: info.id, role: info.role, createdAt: info.time.created })
    }
    cursor = page.cursor?.next
    if (cursor && seen.has(cursor)) throw new Error("repeated message cursor")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return messages
}
