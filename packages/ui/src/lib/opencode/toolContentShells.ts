/**
 * Tool calls whose result the server left out of a message page.
 *
 * Results (file reads, shell output, skill bodies) are most of a page's bytes,
 * and the transcript shows them only in an expanded row. The session message
 * loader asks for pages with finished results replaced by a marker in the
 * call's metadata (`packages/web/server/lib/opencode/message-shells.js`); a
 * row that needs the result fetches its whole message by id. Everything a
 * collapsed row reads (status, time, input, metadata, error) stays in the page.
 */

import { z } from "zod"

import { compact, type Part, type ToolPart } from "./model"
import { isNavigationTool } from "./tools"

/** Request header asking for shelled pages. */
export const PART_SHELLS_HEADER = "x-openchamber-part-shells"

/**
 * The header value. The server also accepts tools to keep whole after the
 * version (`v1,shell`); every row here opens on a click, so none are listed.
 */
export const PART_SHELLS_VERSION = "v1"

const CONTENT_SHELL_METADATA_KEY = "openchamberContentShell"

const contentShellMarker = z.object({
  chars: z.number(),
  // An OpenChamber tool envelope the result was: what the collapsed row says about the call.
  envelope: z.object({ ok: z.boolean(), action: z.string().min(1) }).optional().catch(undefined),
})

const readMarker = (part: Part) => {
  if (part.type !== "tool") return null
  if (part.state.status !== "completed" && part.state.status !== "error") return null
  const marker = contentShellMarker.safeParse(part.state.metadata?.[CONTENT_SHELL_METADATA_KEY])
  return marker.success ? marker.data : null
}

/**
 * Length of the result text the server left out of this call, or `null` when
 * the call is whole: a call from the event stream, a single-message fetch, or
 * any server that does not shell pages.
 */
export function toolContentShellChars(part: Part): number | null {
  return readMarker(part)?.chars ?? null
}

/**
 * The action and outcome of the OpenChamber tool envelope the server left out
 * of this call, or `null` when it left out none.
 */
export function toolContentShellEnvelope(part: Part): { ok: boolean; action: string } | null {
  return readMarker(part)?.envelope ?? null
}

/**
 * A finished `read` or `skill` call as the store keeps it: its row opens the
 * file in the app and never shows the result, so the result is left out the
 * moment the call finishes, marked the same way a shelled page marks it.
 */
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
