import assert from "node:assert/strict"
import test from "node:test"

import { runStep } from "./steps.mjs"

const stand = { apiUrl: "http://localhost:3000" }
const patch = { openchamber: { lead: { at: 1, digest: { updatedAt: 1, now: ["Sample work"] } } } }
const step = { do: "session.seedMetadata", session: "lead", patch }

test("seedMetadata sends the patch for the scenario's session through the stand API", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}))
  await runStep(step, { stand, vars: { lead: "ses_sample" } })

  assert.equal(fetch.mock.callCount(), 1)
  const [url, options] = fetch.mock.calls[0].arguments
  assert.equal(url, `${stand.apiUrl}/api/openchamber/sessions/ses_sample/metadata`)
  assert.equal(options.method, "POST")
  assert.deepEqual(JSON.parse(options.body), { patch })
})

test("seedMetadata refuses a raw session id and reports a refused write", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 409 }))

  await assert.rejects(runStep({ ...step, session: "ses_sample" }, { stand, vars: {} }), /needs a session created by this scenario/)
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(runStep(step, { stand, vars: { lead: "ses_sample" } }), /seeding session metadata answered 409/)
})
