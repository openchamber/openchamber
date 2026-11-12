/**
 * Reading run directories written by the profile:* commands, and the one
 * definition of a run that measured nothing, shared by `aggregate-runs.mjs`
 * and `compare-runs.mjs`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** The `*-summary.json` in a run directory, or null. */
export const readSummary = (directory) => {
  if (!existsSync(directory)) return null
  const file = readdirSync(directory).find((name) => name.endsWith("-summary.json"))
  return file ? { file: join(directory, file), kind: file.replace(/-summary\.json$/, ""), data: JSON.parse(readFileSync(join(directory, file), "utf8")) } : null
}

/** Reasons a run measured nothing, from the validity flags the profilers write. */
export const invalidReasons = (data) => {
  const reasons = []
  if (data.renderedStream === false) reasons.push("never rendered the stream")
  if (data.assistantResponse && data.assistantResponse.responded === false) reasons.push("no assistant response")
  if (data.reachedIdle === false) reasons.push("never reached idle")
  if (data.instrumented !== false && data.metrics?.taskCount === 0) reasons.push("trace had no tasks")
  if (data.frameLiveness && Number(data.frameLiveness.framesPerSecond ?? data.frameLiveness) < 10) reasons.push("renderer throttled")
  if (Array.isArray(data.failures) && data.failures.length > 0 && data.runs === data.failures.length) reasons.push("every launch failed")
  if (data.rows === 0) reasons.push("no sidebar rows")
  if (data.editorFound === false) reasons.push("composer editor not found")
  if (data.toggleValidity?.ok === false) reasons.push(`toggle validity failed: ${data.toggleValidity.failures.join("; ")}`)
  return reasons
}

/**
 * What made a run differ from a plain production measurement: injected CSS or
 * script, the render probe, heap sampling. Such runs are valid for
 * attribution, never for quoting a timing.
 */
export const modifications = (data) => {
  const notes = []
  if (data.injectedCss) notes.push("injected CSS")
  if (data.injectedScript) notes.push(`injected ${String(data.injectedScript).split("/").pop()}`)
  if (data.renderProbe) notes.push("render probe")
  if (data.heapSampling) notes.push("heap sampling")
  if (data.quiet) notes.push("quiet (no prompt)")
  if (data.directoryAlignment && data.directoryAlignment.aligned === false) notes.push("session directory not active")
  return notes
}
