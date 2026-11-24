
import type { ContextPartMetadata } from "@/lib/messages/contextParts"
import type { Metadata } from "./model"

export const toJsonRecord = (value: Metadata | ContextPartMetadata): Metadata =>
  // SAFETY: JSON.stringify emits only JSON values, so parsing its output back
  // yields a record of JsonValue by construction.
  JSON.parse(JSON.stringify(value)) as Metadata
