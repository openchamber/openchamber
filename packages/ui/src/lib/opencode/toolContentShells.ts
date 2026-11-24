
import { z } from "zod"

import { compact, type Part, type ToolPart } from "./model"
import { isNavigationTool, OPENCODE_TOOLS } from "./tools"

export const PART_SHELLS_HEADER = "x-openchamber-part-shells"

/**
 * The header value. The server also accepts tools to keep whole after the
 * version (`v1,shell`). A question call's result holds the user's answers,
 * which the collapsed and expanded rows show without a per-row fetch.
 */
const PART_SHELLS_KEEP_WHOLE_TOOLS = [OPENCODE_TOOLS.question] as const
export const PART_SHELLS_VERSION = ["v1", ...PART_SHELLS_KEEP_WHOLE_TOOLS].join(",")

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
