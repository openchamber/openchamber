import assert from "node:assert/strict"
import test from "node:test"

import { projectSessionLoadPerformance } from "./profile-browser-session-load.mjs"

test("session-load summary exports only the approved diagnostic fields", () => {
  const projectInBrowser = Function(
    "events",
    "recordingStartedAt",
    `return (${projectSessionLoadPerformance.toString()})(events, recordingStartedAt)`,
  )
  const projected = projectInBrowser([{
    operation: "session-messages.initial",
    caller: "initial",
    queuedMs: 3,
    requestLimit: 50,
    cursorPresent: false,
    durationMs: 17,
    outcome: "complete",
    retryCount: 1,
    recordCount: 50,
    at: 1_250,
    runtimeKey: "secret-runtime",
    directory: "/secret/worktree",
    sessionID: "secret-session",
    message: "secret-message",
    content: "secret-content",
    authorization: "Bearer secret-token",
    token: "secret-token",
    password: "secret-password",
    cookie: "secret-cookie",
    credentials: { apiKey: "secret-api-key" },
  }, {
    operation: "session-messages.older",
    caller: "older",
    queuedMs: "secret-queued",
    durationMs: 5,
    outcome: "complete",
    retryCount: { value: "secret-retry" },
    recordCount: Number.POSITIVE_INFINITY,
    at: 1_300,
  }, {
    operation: "secret-operation",
    caller: "secret-caller",
    durationMs: { secret: "secret-duration" },
    outcome: "secret-outcome",
    at: 1_300,
  }], 1_000)

  assert.deepEqual(projected, {
    bufferAtCapacity: false,
    events: [{
      operation: "session-messages.initial",
      caller: "initial",
      queuedMs: 3,
      requestLimit: 50,
      cursorPresent: false,
      durationMs: 17,
      outcome: "complete",
      retryCount: 1,
      recordCount: 50,
      offsetMs: 250,
    }, {
      operation: "session-messages.older",
      caller: "older",
      durationMs: 5,
      outcome: "complete",
      offsetMs: 300,
    }],
  })

  const serialized = JSON.stringify(projected)
  for (const secret of [
    "secret-runtime",
    "/secret/worktree",
    "secret-session",
    "secret-message",
    "secret-content",
    "secret-token",
    "secret-password",
    "secret-cookie",
    "secret-api-key",
    "secret-operation",
    "secret-caller",
    "secret-duration",
    "secret-outcome",
    "secret-queued",
    "secret-retry",
  ]) {
    assert.equal(serialized.includes(secret), false)
  }
})

test("session-load summary reports when the source buffer is at capacity", () => {
  const events = Array.from({ length: 1000 }, () => ({ at: 1_000 }))
  assert.equal(projectSessionLoadPerformance(events, 1_000).bufferAtCapacity, true)
})

test("session-load summary rejects an invalid recording timestamp", () => {
  assert.deepEqual(projectSessionLoadPerformance([{
    operation: "session-messages.initial",
    caller: "initial",
    durationMs: 1,
    outcome: "complete",
    at: 1_000,
  }], Number.NaN), {
    bufferAtCapacity: false,
    events: [],
  })
})
