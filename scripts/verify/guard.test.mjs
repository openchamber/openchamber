import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { resolveBunExecutable } from "../lib/bun-executable.mjs"
import { createGuardReader, describeHostedRequests, guardEnv, guardedCommand, openCodeArmed } from "./guard.mjs"
import { hasOnlyLoopback, namespaceCommands } from "./namespace.mjs"
import { playOrRetry } from "./run.mjs"

// `.invalid` never resolves, so nothing leaves the machine when the guard is broken.
const ATTEMPTS = `
const http = require("node:http"), https = require("node:https"), net = require("node:net"), tls = require("node:tls"), http2 = require("node:http2")
const settle = (emitter) => new Promise((done) => { emitter.on("error", (error) => done(error.message)); emitter.on("connect", () => done("connected")); emitter.on("response", () => done("answered")) })
const attempt = async (name, run) => { let outcome; try { outcome = await run() } catch (error) { outcome = error.cause?.message ?? error.message } console.log(name + "=" + outcome) }
;(async () => {
  await attempt("fetch", () => fetch("https://api.guard.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [] }) }))
  await attempt("request", () => fetch(new Request("https://api.guard.invalid/v1/responses", { method: "POST", body: JSON.stringify({ model: "other" }) })))
  await attempt("http", () => settle(http.request("http://http.guard.invalid/")))
  await attempt("https", () => settle(https.get({ hostname: "https.guard.invalid" })))
  await attempt("net", () => settle(net.connect(443, "net.guard.invalid")))
  await attempt("tls", () => settle(tls.connect({ host: "tls.guard.invalid", port: 443 })))
  await attempt("http2", () => settle(http2.connect("https://http2.guard.invalid")))
  await attempt("redirect", () => fetch(process.env.LOCAL_URL + "redirect", { method: "POST", body: "{}" }))
  await attempt("ws", () => { new WebSocket("wss://ws.guard.invalid/v1/responses"); return "opened" })
  if (process.versions.bun) await attempt("bunfetch", () => Bun.fetch("https://bun.guard.invalid"))
  await attempt("local", async () => (await fetch(process.env.LOCAL_URL, { method: "POST", body: "{}" })).text())
  process.exit(0)
})()
`

const runtimes = [["node", process.execPath, ["-e", ATTEMPTS]], ["bun", resolveBunExecutable(), ["-e", ATTEMPTS]]]
for (const [name, executable, args] of runtimes) {
  test(`${name}: every way out is refused, loopback works, a model request is recorded`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify guard "))
    const log = join(dir, "guard.log")
    const server = createServer((request, response) => (request.url === "/redirect" ? response.writeHead(307, { location: "https://redirect.guard.invalid/v1/messages" }).end() : response.end("loopback")))
    await new Promise((done) => server.listen(0, "127.0.0.1", done))
    try {
      const child = spawn(executable, args, { env: { ...process.env, ...guardEnv(log), LOCAL_URL: `http://127.0.0.1:${server.address().port}/` } })
      let output = ""
      child.stdout.on("data", (chunk) => { output += chunk })
      child.stderr.on("data", (chunk) => { output += chunk })
      await new Promise((done) => child.on("close", done))
      for (const way of ["fetch", "request", "http", "https", "net", "tls", "http2", "ws"]) assert.match(output, new RegExp(`^${way}=The verify stand refuses connections to `, "m"), output)
      if (name === "bun") assert.match(output, /^bunfetch=.*(proxy|ConnectionRefused|Unable to connect|127\.0\.0\.1)/mi, output)
      assert.match(output, name === "bun" ? /^redirect=.*(proxy|ConnectionRefused|Unable to connect|127\.0\.0\.1)/mi : /^redirect=The verify stand refuses connections to redirect\.guard\.invalid/m, output)
      assert.match(output, /^local=loopback$/m)
      const requests = createGuardReader(log)()
      assert.deepEqual(requests.map(({ host, model }) => [host, model]), [["api.guard.invalid", "big-pickle"], ["api.guard.invalid", "other"]])
      assert.match(describeHostedRequests(requests), /provider api\.guard\.invalid, model big-pickle/)
      assert.match(readFileSync(log, "utf8"), /"type":"armed"/)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("a process the guarded one starts is guarded too, and only a serving OpenCode counts as armed", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-guard-"))
  const log = join(dir, "guard.log")
  try {
    const since = Date.now()
    const run = (args) => spawnSync(process.execPath, args, { env: { ...process.env, ...guardEnv(log) }, encoding: "utf8" })
    run(["-e", `require("node:child_process").spawnSync(process.execPath, ["-e", "fetch('https://child.guard.invalid/v1/messages',{method:'POST',body:JSON.stringify({model:'m'})}).catch(()=>{})"])`])
    assert.equal(createGuardReader(log)()[0]?.host, "child.guard.invalid")
    assert.equal(openCodeArmed(log, since), false)
    run(["-e", "0", "serve"])
    assert.equal(openCodeArmed(log, since), true)
    assert.equal(openCodeArmed(log, Date.now() + 1000), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a scenario that asked a hosted model is not retried into a pass", async () => {
  let plays = 0
  const result = await playOrRetry(async () => ({ ok: plays++ > 0, hosted: plays === 1, failure: {} }), "out", true)
  assert.equal(result.ok, false)
  assert.equal(plays, 1)
})

test("a hosted request during the retry is reported over the first failure", async () => {
  let plays = 0
  const result = await playOrRetry(async () => (plays++ === 0 ? { ok: false, failure: { message: "first" } } : { ok: false, hosted: true, failure: { message: "hosted" } }), "out", true)
  assert.equal(result.failure.message, "hosted")
})

test("macOS refuses a native program and an address literal, not only guarded runtimes", { skip: process.platform !== "darwin" }, async () => {
  const server = createServer((_request, response) => response.end("loopback"))
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const curl = async (url) => {
    const { executable, args } = guardedCommand("/usr/bin/curl", ["-sS", "-m", "5", "--noproxy", "*", url])
    const child = spawn(executable, args)
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    const code = await new Promise((done) => child.on("close", done))
    return { code, output }
  }
  try {
    assert.equal((await curl(`http://127.0.0.1:${server.address().port}/`)).output, "loopback")
    const refused = await curl("http://192.0.2.1/")
    assert.equal(refused.code, 7, refused.output)
  } finally { server.close() }
})

test("Linux: a namespace holds only loopback, and a native program cannot leave it", { skip: process.platform !== "linux" || hasOnlyLoopback() }, () => {
  const probe = `
const { networkInterfaces } = require("node:os"), http = require("node:http"), { spawnSync } = require("node:child_process")
const server = http.createServer((q, s) => s.end("loopback")).listen(0, "127.0.0.1", async () => {
  const local = await (await fetch("http://127.0.0.1:" + server.address().port)).text()
  const curl = spawnSync("curl", ["-sS", "-m", "5", "--noproxy", "*", "http://192.0.2.1/"], { encoding: "utf8" })
  console.log(JSON.stringify({ local, uid: process.getuid(), outside: Object.values(networkInterfaces()).flat().filter((a) => !a.internal).length, curl: curl.status, marker: process.env.MARKER }))
  process.exit()
})`
  const env = { PATH: process.env.PATH, MARKER: "a b" }
  const answers = namespaceCommands([process.execPath, "-e", probe], env).map(([executable, ...args]) => spawnSync(executable, args, { env, encoding: "utf8" })).filter((run) => run.status === 0).map((run) => JSON.parse(run.stdout))
  assert.ok(answers.length > 0, "neither way into a namespace works here")
  for (const answer of answers) assert.deepEqual(answer, { local: "loopback", uid: process.getuid(), outside: 0, curl: 7, marker: "a b" })
})
