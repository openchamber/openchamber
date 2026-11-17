import assert from "node:assert/strict"
import test from "node:test"

import { reservePort, wait } from "../perf/cdp.mjs"
import { startFixture } from "../perf/isolated-server.mjs"

test("profiling fixtures do not expose verification request controls", async () => {
  const port = await reservePort()
  const fixture = await startFixture({ port })
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__verify/active?session=s&prompt=p`)
    assert.equal(response.status, 404)
  } finally {
    await fixture.stop()
  }
})

test("verification observes the actual follow-up request and clears closed requests", async () => {
  const port = await reservePort()
  const fixture = await startFixture({ port, verifyControl: true })
  const base = `http://127.0.0.1:${port}`
  const controllers = []
  const request = async (prompt, model = "think-30s") => {
    const controller = new AbortController()
    controllers.push(controller)
    return fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session-id": "session-a" },
      body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal,
    })
  }
  const active = async (prompt, session = "session-a") => {
    const query = new URLSearchParams({ session, prompt })
    const response = await fetch(`${base}/__verify/active?${query}`)
    assert.equal(response.headers.get("cache-control"), "no-store")
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ["active"])
    return body.active
  }
  const waitInactive = async (prompt) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!await active(prompt)) return
      await wait(25)
    }
    assert.fail(`The closed request for ${prompt} remained active`)
  }
  try {
    await request("first prompt")
    assert.equal(await active("first prompt"), true)
    const auxiliary = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session-id": "session-a" },
      body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "queued follow up" }] }),
    })
    await auxiliary.json()
    assert.equal(await active("queued follow up"), false)
    await request([{ type: "text", text: "Context\nqueued follow up" }])
    assert.equal(await active("queued follow up"), true)
    assert.equal(await active("queued follow up", "another-session"), false)
    controllers[0].abort()
    await waitInactive("first prompt")
    assert.equal(await active("queued follow up"), true)
    controllers[1].abort()
    await waitInactive("queued follow up")
    const completed = await request("fast prompt", "stream-20000cps")
    await completed.text()
    assert.equal(await active("fast prompt"), false)
  } finally {
    for (const controller of controllers) controller.abort()
    await fixture.stop()
  }
})
