
import { z } from "zod"

import { compact, type Part, type ToolPart } from "./model"
import { isNavigationTool } from "./tools"

export const PART_SHELLS_HEADER = "x-openchamber-part-shells"

export const PART_SHELLS_VERSION = "v1"

const CONTENT_SHELL_METADATA_KEY = "openchamberContentShell"

const contentShellMarker = z.object({
  chars: z.number(),
  envelope: z.object({ ok: z.boolean(), action: z.string().min(1) }).optional().catch(undefined),
})

const readMarker = (part: Part) => {
  if (part.type !== "tool") return null
  if (part.state.status !== "completed" && part.state.status !== "error") return null
  const marker = contentShellMarker.safeParse(part.state.metadata?.[CONTENT_SHELL_METADATA_KEY])
  return marker.success ? marker.data : null
}

export function toolContentShellChars(part: Part): number | null {
  return readMarker(part)?.chars ?? null
}

export function toolContentShellEnvelope(part: Part): { ok: boolean; action: string } | null {
  return readMarker(part)?.envelope ?? null
}

export function withoutUnshownResult(part: ToolPart): ToolPart {
  if (!isNavigationTool(part.tool) || toolContentShellChars(part) !== null) return part
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return part
  const chars = state.output?.length ?? 0
  if (chars === 0 && !(state.status === "completed" && state.attachments?.length)) return part
  const metadata = { ...state.metadata, [CONTENT_SHELL_METADATA_KEY]: { chars } }
  if (state.status === "error") return { ...part, state: compact({ ...state, output: undefined, metadata }) }
  return { ...part, state: compact({ ...state, output: "", attachments: undefined, metadata }) }
}
