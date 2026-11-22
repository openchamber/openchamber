import assert from "node:assert/strict"
import { test } from "node:test"

import { countRunReplies } from "./seed-long-session.mjs"

// Regression coverage for #2157: the seeder's final validation used to
// count the session's latest assistant replies with no per-run scope, so
// reusing a session (--session) that already held enough historical
// replies passed even when the current run's prompts went unanswered.
// The validation now counts only replies after the pre-run boundary (the
// latest assistant message that existed before the run sent anything).
const msg = (id) => ({ id, role: "assistant" })

test("reused session with only historical replies counts zero run replies", () => {
  const fetched = [msg("a1"), msg("a2"), msg("a3")]
  assert.equal(countRunReplies(fetched, "a3"), 0)
})

test("reused session counts only the replies after the boundary", () => {
  const fetched = [msg("a1"), msg("a2"), msg("a3"), msg("a4")]
  assert.equal(countRunReplies(fetched, "a2"), 2)
})

test("boundary scrolled out of the fetched window counts the whole window", () => {
  const fetched = [msg("a7"), msg("a8"), msg("a9")]
  assert.equal(countRunReplies(fetched, "a3"), 3)
})

test("fresh session (null boundary) counts every reply", () => {
  const fetched = [msg("a1"), msg("a2")]
  assert.equal(countRunReplies(fetched, null), 2)
})

test("empty history counts zero", () => {
  assert.equal(countRunReplies([], null), 0)
  assert.equal(countRunReplies([], "a1"), 0)
})
