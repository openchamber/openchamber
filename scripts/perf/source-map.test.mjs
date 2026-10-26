import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createSourceMapper } from "./source-map.mjs"

test("maps chunk positions to source lines, including negative deltas and dependency paths", () => {
  const dist = mkdtempSync(join(tmpdir(), "source-map-"))
  try {
    mkdirSync(join(dist, "assets"))
    // Line 1: col 0 -> a.tsx:3, col 3 -> a.tsx:3 col 3. Line 2: col 0 -> a.tsx:1 (line delta -2).
    // Line 3: col 0 -> the dependency source.
    writeFileSync(join(dist, "assets", "main-abc.js.map"), JSON.stringify({
      version: 3,
      sources: ["../../ui/src/a.tsx", "../../node_modules/.bun/zustand@5/node_modules/zustand/esm/vanilla.mjs"],
      mappings: "AAEA,GAAG;AAFH;ACAA",
    }))
    const mapper = createSourceMapper(dist)
    assert.deepEqual(mapper.mapPosition("http://127.0.0.1:4799/assets/main-abc.js", 1, 5), { source: "ui/src/a.tsx", line: 3 })
    assert.deepEqual(mapper.mapPosition("http://127.0.0.1:4799/assets/main-abc.js", 2, 0), { source: "ui/src/a.tsx", line: 1 })
    assert.deepEqual(mapper.mapPosition("http://127.0.0.1:4799/assets/main-abc.js", 3, 0), { source: "nm:zustand/esm/vanilla.mjs", line: 1 })
    assert.equal(mapper.mapFrame("at render (http://127.0.0.1:4799/assets/main-abc.js:1:4)"), "render ui/src/a.tsx:3")
    assert.equal(mapper.mapPosition("http://127.0.0.1:4799/assets/other.js", 1, 0), null)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
