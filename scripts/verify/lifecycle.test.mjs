import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs"
import { basename, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { processDescendants, readProcesses, reapStaleStands } from "./processes.mjs"

const checkout = fileURLToPath(new URL("../../", import.meta.url))
const hook = new URL("./test-fixtures/lifecycle.mjs", import.meta.url).href
const runner = fileURLToPath(new URL("./run.mjs", import.meta.url))

// These are real stand/browser runs, deliberately opt-in rather than part of
// a unit-test fan-out that could start several Vite servers simultaneously.
test("real runner cleanup on success, scenario failure, thrown error and both signals", { skip: process.env.VERIFY_LIFECYCLE_TEST !== "1", timeout: 1_200_000 }, async (t) => {
  for (const mode of ["normal", "failure", "throw", "SIGINT", "SIGTERM"]) {
    await t.test(mode, async () => {
      const out = join(checkout, `tmp/verify/lifecycle-${Date.now()}-${mode}`)
      mkdirSync(out, { recursive: true })
      const child = spawn(process.execPath, ["--import", hook, runner, "workspace.lifecycle.case", "--out", out], {
        cwd: checkout,
        env: { ...process.env, VERIFY_LIFECYCLE_MODE: mode },
        signal: AbortSignal.timeout(300_000),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      let root
      let signaled = false
      let captured = false
      let watcher
      let ownerReleased = Promise.resolve()
      const identities = new Set()
      const collect = (chunk) => {
        output += chunk
        const match = /stand at (.+): api \d+/.exec(output)
        if (match && !root) {
          root = match[1]
          const registry = join(checkout, "tmp/verify/owners")
          const file = join(registry, `${basename(root)}.json`)
          ownerReleased = new Promise((done) => {
            if (!existsSync(file)) { done(); return }
            watcher = watch(registry, () => { if (!existsSync(file)) done() })
          })
        }
        if (root && !captured && (mode === "throw" ? output.includes("stand ready after") : output.includes("warmed up after"))) {
          captured = true
          const records = readProcesses()
          const descendants = processDescendants(records, new Set([child.pid]))
          for (const record of records) {
            if (descendants.has(record.pid) || record.cwd?.startsWith(root) || record.command.includes(root)) identities.add(`${record.pid}:${record.started}`)
          }
        }
        if (!signaled && mode.startsWith("SIG") && output.includes("warmed up after")) {
          signaled = true
          child.kill(mode)
        }
      }
      child.stdout.on("data", collect)
      child.stderr.on("data", collect)
      try {
        const result = await new Promise((done, reject) => child.once("error", reject).once("exit", (code, signal) => done({ code, signal })))
        assert.ok(root, output)
        if (process.platform === "win32" && mode.startsWith("SIG")) assert.equal(result.signal, mode, output)
        else assert.equal(result.code, mode === "normal" ? 0 : mode === "failure" ? 1 : mode === "SIGINT" ? 130 : mode === "SIGTERM" ? 143 : 2, output)
        await ownerReleased
        const remainingProcesses = () => readProcesses().filter((record) => !record.state?.startsWith("Z") && (
          record.cwd?.startsWith(root) || record.command.includes(root) || identities.has(`${record.pid}:${record.started}`)
        ))
        const remaining = remainingProcesses()
        assert.deepEqual(remaining.map((record) => ({ pid: record.pid, command: record.command })), [], output)
        assert.equal(existsSync(root), false, output)
        const infoFile = join(out, "stand.json")
        if (existsSync(infoFile)) {
          const info = JSON.parse(readFileSync(infoFile, "utf8"))
          assert.equal(existsSync(join(checkout, `packages/web/node_modules/.vite-dev-${info.uiPort}`)), false, output)
        }
        console.log(`[lifecycle] ${mode}: no stand processes, root or Vite cache`)
      } finally {
        watcher?.close()
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM")
          await new Promise((done) => child.once("exit", done))
        }
        await reapStaleStands({ checkout, log: console.log })
      }
    })
  }
})
