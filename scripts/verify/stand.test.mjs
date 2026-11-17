import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { test } from "node:test"

import { closeStandLog, gitIn, parseStandSessions, readStandSessions, resetWorktrees } from "./stand.mjs"

const projectAt = (root) => {
  const project = join(root, "project")
  gitIn(root, ["init", "-q", "-b", "main", project])
  gitIn(project, ["commit", "-q", "--allow-empty", "-m", "Initial fixture"])
  return project
}

test("reset removes scenario worktrees and branches so names can be reused", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    const child = join(root, "worker")
    gitIn(project, ["worktree", "add", "-q", "-b", "worker-fix", child])
    resetWorktrees({ root, project })
    assert.equal(existsSync(child), false)
    assert.equal(gitIn(project, ["branch", "--format=%(refname:short)"]).trim(), "main")
    gitIn(project, ["worktree", "add", "-q", "-b", "worker-fix", child])
    resetWorktrees({ root, project })
    assert.equal(gitIn(project, ["worktree", "list", "--porcelain"]).split("worktree ").length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a foreign worktree prevents every removal, including stand-owned ones", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  const foreignRoot = mkdtempSync(join(tmpdir(), "verify-worktree-foreign-"))
  try {
    const project = projectAt(root)
    const owned = join(root, "owned")
    const foreign = join(foreignRoot, "foreign")
    gitIn(project, ["worktree", "add", "-q", "-b", "owned", owned])
    gitIn(project, ["worktree", "add", "-q", "-b", "foreign", foreign])
    assert.throws(() => resetWorktrees({ root, project }), /outside.*nothing was removed/)
    assert.equal(existsSync(owned), true)
    assert.equal(existsSync(foreign), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(foreignRoot, { recursive: true, force: true })
  }
})

test("a project outside the stand cannot have its branches reset", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  const foreignRoot = mkdtempSync(join(tmpdir(), "verify-worktree-foreign-"))
  try {
    const project = projectAt(foreignRoot)
    gitIn(project, ["branch", "keep-me"])
    assert.throws(() => resetWorktrees({ root, project }), /project.*outside/)
    assert.match(gitIn(project, ["branch", "--format=%(refname:short)"]), /keep-me/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(foreignRoot, { recursive: true, force: true })
  }
})

test("reset keeps root, archived and child sessions with their authoritative directories", () => {
  assert.deepEqual(parseStandSessions({ data: [
    { id: "root", location: { directory: "C:/stand/project" } },
    { id: "child", parentID: "root", directory: "C:/stand/project" },
    { id: "archived", time: { archived: 1 }, location: { directory: "C:/stand/other" } },
  ] }), [
    { id: "root", directory: "C:/stand/project" },
    { id: "child", directory: "C:/stand/project" },
    { id: "archived", directory: "C:/stand/other" },
  ])
})

test("reset refuses invalid lists while accepting authoritative empty state", () => {
  assert.throws(() => parseStandSessions({ error: "unavailable" }), /invalid/)
  assert.deepEqual(parseStandSessions({ data: [] }), [])
})

test("reset follows a cursor even on a short page until the terminal empty page", async (t) => {
  const pages = [
    { data: [{ id: "root", directory: "C:/stand" }], cursor: { next: "root cursor" } },
    { data: [{ id: "child", directory: "C:/stand" }], cursor: { next: "child cursor" } },
    { data: [] },
  ]
  const urls = []
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url)
    return Response.json(pages.shift())
  })
  assert.deepEqual(await readStandSessions("http://stand"), [
    { id: "root", directory: "C:/stand" },
    { id: "child", directory: "C:/stand" },
  ])
  assert.deepEqual(urls, [
    "http://stand/api/session?limit=1000",
    "http://stand/api/session?limit=1000&cursor=root%20cursor",
    "http://stand/api/session?limit=1000&cursor=child%20cursor",
  ])
})

test("reset fails on a later-page error instead of returning a partial list", async (t) => {
  const pages = [
    Response.json({ data: [{ id: "root", directory: "C:/stand" }], cursor: { next: "more" } }),
    Response.json({ error: "unavailable" }, { status: 503 }),
  ]
  t.mock.method(globalThis, "fetch", async () => pages.shift())
  await assert.rejects(readStandSessions("http://stand"), /answered 503/)
})

test("reset refuses a repeated continuation cursor", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [{ id: "root", directory: "C:/stand" }],
    cursor: { next: "same" },
  }))
  await assert.rejects(readStandSessions("http://stand"), /did not advance/)
})

test("reset refuses an empty page that claims a continuation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [], cursor: { next: "more" } }))
  await assert.rejects(readStandSessions("http://stand"), /did not advance/)
})

test("shutdown bounds a descendant's open log pipe and flushes buffered output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const chunks = []
  const log = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done() } })
  const pipe = new PassThrough()
  pipe.pipe(log, { end: false })
  pipe.write("queued output\n")
  const closing = closeStandLog(log, [pipe])
  t.mock.timers.tick(1000)
  await closing
  assert.equal(pipe.destroyed, true)
  assert.equal(log.writableFinished, true)
  assert.equal(chunks.join(""), "queued output\n")
})

test("shutdown drains a closed pipe before closing its log", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const chunks = []
  const log = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done() } })
  const pipe = new PassThrough()
  pipe.pipe(log, { end: false })
  pipe.end("last output\n")
  await closeStandLog(log, [pipe])
  assert.equal(log.writableFinished, true)
  assert.equal(chunks.join(""), "last output\n")
})
