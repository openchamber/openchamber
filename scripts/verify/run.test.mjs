import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { runScenario } from "./run.mjs"

test("the vocabulary gives each target one definition", () => {
  const vocabulary = readFileSync(new URL("./vocabulary.json", import.meta.url), "utf8")
  const names = [...vocabulary.matchAll(/^  "([^"]+)":/gm)].map((match) => match[1])
  assert.equal(names.length, Object.keys(JSON.parse(vocabulary)).length, "Duplicate vocabulary names silently replace an earlier definition")
})

test("reset failures become scenario results and do not stop later scenarios", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "verify-run-reset-"))
  try {
    let resets = 0
    const stand = {
      reset: async () => {
        resets += 1
        if (resets === 1) return { failure: "Git reset failed; rebuilt the fixture" }
        if (resets === 3) throw new Error("Settings reset failed")
      },
    }
    let pages = 0
    const browser = { newPage: async () => {
      pages += 1
      return {
        client: { send: async () => {} },
        allowDownloads: async () => {},
        screenshot: async () => {},
        dispose: async () => {},
        consoleErrors: [],
        sourceUpdates: [],
      }
    } }
    for (const id of ["recovered", "next", "unrecoverable"]) {
      const result = await runScenario({ scenario: { id, title: id, steps: [] }, stand, browser, outDir, round: 1 })
      assert.equal(result.ok, id === "next")
      if (!result.ok) {
        assert.equal(result.failure.do, "reset")
        assert.equal(result.failure.message, id === "recovered" ? "Git reset failed; rebuilt the fixture" : "Settings reset failed")
      }
      assert.deepEqual(JSON.parse(readFileSync(join(outDir, id, "result.json"), "utf8")), result)
    }
    assert.equal(resets, 3)
    assert.equal(pages, 1)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
