/**
 * Maps positions in built chunks back to source, for attribution runs on the
 * diagnostic build (`bun run build:web:diag`, which writes source maps).
 *
 * A minimal reader of the standard source map v3 `mappings` field, so the perf
 * scripts need no dependency. Positions in CPU profiles and trace stacks are
 * `/assets/<chunk>.js` URLs; the map is read from `<dist>/assets/<chunk>.js.map`.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const BASE64_VALUE = new Map([...BASE64].map((character, index) => [character, index]))

// One line of `mappings` into segments of [generatedColumn, source, line, column].
const decodeLine = (text, state) => {
  const segments = []
  let generatedColumn = 0
  for (const encoded of text.split(",")) {
    if (!encoded) continue
    const fields = []
    let value = 0
    let shift = 0
    for (const character of encoded) {
      const digit = BASE64_VALUE.get(character) ?? 0
      value += (digit & 31) << shift
      if (digit & 32) { shift += 5; continue }
      fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
      value = 0
      shift = 0
    }
    generatedColumn += fields[0]
    if (fields.length < 4) continue
    state.source += fields[1]
    state.line += fields[2]
    state.column += fields[3]
    segments.push([generatedColumn, state.source, state.line, state.column])
  }
  return segments
}

const parseMap = (raw) => {
  const map = JSON.parse(raw)
  const state = { source: 0, line: 0, column: 0 }
  const lines = String(map.mappings ?? "").split(";").map((line) => decodeLine(line, state))
  return { sources: map.sources ?? [], lines }
}

// Shortens a map's source path: `../../ui/src/x.tsx` -> `ui/src/x.tsx`, a
// dependency under bun's isolated install -> `nm:<package path>`.
const shortenSource = (source) => String(source)
  .replace(/^(\.\.\/)+/, "")
  .replace(/^.*node_modules\/\.bun\/[^/]+\/node_modules\//, "nm:")
  .replace(/^.*node_modules\//, "nm:")

/**
 * Returns `{ mapPosition(url, line, column), mapFrame(text) }` over the maps in
 * `distDir`, or a mapper that returns null everywhere when no directory is
 * given. `line` is 1-based, `column` 0-based (CPU profile frames are 0-based
 * in both, so pass `lineNumber + 1`).
 */
export const createSourceMapper = (distDir) => {
  const maps = new Map()
  const mapFor = (file) => {
    if (maps.has(file)) return maps.get(file)
    const path = distDir ? join(distDir, "assets", `${file}.map`) : null
    const parsed = path && existsSync(path) ? parseMap(readFileSync(path, "utf8")) : null
    maps.set(file, parsed)
    return parsed
  }

  const mapPosition = (url, line, column) => {
    const file = String(url).split("/assets/")[1]?.split("?")[0]
    if (!file) return null
    const map = mapFor(file)
    const segments = map?.lines[line - 1]
    if (!segments?.length) return null
    let found = null
    for (const segment of segments) {
      if (segment[0] > column) break
      found = segment
    }
    if (!found) return null
    return { source: shortenSource(map.sources[found[1]]), line: found[2] + 1 }
  }

  // A stack line such as `at fn (http://host/assets/x.js:12:34)`.
  const mapFrame = (frame) => {
    const match = String(frame).match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/)
    if (!match) return String(frame)
    const position = mapPosition(match[1], Number(match[2]), Number(match[3]) - 1)
    const name = String(frame).trim().replace(/^at\s+/, "").split(" (")[0]
    return position ? `${name} ${position.source}:${position.line}` : String(frame)
  }

  return { available: Boolean(distDir), mapPosition, mapFrame }
}
