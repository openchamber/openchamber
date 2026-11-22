import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { test } from "node:test"

import { closeStandLog, deleteSavedDrafts, gitIn, parseStandSessions, readStandSessions, resetProject, resetWorktrees } from "./stand.mjs"

const projectAt = (root) => {
  const project = join(root, "project")
  gitIn(root, ["init", "-q", "-b", "main", project])
  writeFileSync(join(project, "tracked.txt"), "initial\n")
  gitIn(project, ["add", "."])
  gitIn(project, ["commit", "-q", "-m", "Initial fixture"])
  return project
}

for (const state of ["another branch", "dirty tree", "staged change", "merge", "rebase", "new commit"]) {
  test(`reset restores the starting branch and commit after ${state}`, () => {
    const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
    try {
      const project = projectAt(root)
      const initialCommit = gitIn(project, ["rev-parse", "HEAD"]).trim()
      if (["another branch", "merge", "rebase"].includes(state)) gitIn(project, ["checkout", "-qb", "scenario"])
      writeFileSync(join(project, "tracked.txt"), "scenario\n")
      writeFileSync(join(project, "untracked.txt"), "remove\n")
      if (["staged change", "merge", "rebase", "new commit"].includes(state)) gitIn(project, ["add", "."])
      if (["merge", "rebase", "new commit"].includes(state)) gitIn(project, ["commit", "-qm", "Scenario commit"])
      if (["merge", "rebase"].includes(state)) {
        gitIn(project, ["checkout", "-q", "main"])
        writeFileSync(join(project, "tracked.txt"), "main change\n")
        gitIn(project, ["commit", "-qam", "Conflicting commit"])
        assert.throws(() => gitIn(project, state === "merge" ? ["merge", "scenario"] : ["rebase", "scenario"]))
      }
      resetWorktrees({ root, project, initialCommit })
      assert.equal(gitIn(project, ["branch", "--show-current"]).trim(), "main")
      assert.equal(gitIn(project, ["rev-parse", "HEAD"]).trim(), initialCommit)
      assert.equal(gitIn(project, ["status", "--porcelain"]).trim(), "")
      assert.equal(readFileSync(join(project, "tracked.txt"), "utf8"), "initial\n")
      assert.equal(existsSync(join(project, ".git/MERGE_HEAD")), false)
      assert.equal(existsSync(join(project, ".git/rebase-merge")), false)
      assert.equal(gitIn(project, ["branch", "--format=%(refname:short)"]).trim(), "main")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("reset removes scenario worktrees and branches so names can be reused", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    const child = join(root, "worker")
    gitIn(project, ["worktree", "add", "-q", "-b", "worker-fix", child])
    gitIn(project, ["worktree", "lock", child])
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
    writeFileSync(join(project, ".git/config"), "invalid config\n")
    assert.throws(() => resetProject({ root, project }), /outside.*nothing was removed/)
    assert.equal(existsSync(owned), true)
    assert.equal(existsSync(foreign), true)
    assert.equal(existsSync(join(project, ".git/worktrees/foreign")), true)
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

test("reset empties the project's .opencode folder and keeps the folder itself", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    resetWorktrees({ root, project })
    const folder = join(project, ".opencode")
    const before = statSync(folder).ino
    mkdirSync(join(folder, "commands"))
    writeFileSync(join(folder, "commands/net-helper.md"), "Template")
    writeFileSync(join(folder, "opencode.json"), "{}")
    resetWorktrees({ root, project })
    assert.deepEqual(readdirSync(folder), [])
    assert.equal(statSync(folder).ino, before, "OpenCode stops reading a config folder that was removed and made again at once")
    assert.equal(gitIn(project, ["status", "--porcelain"]).trim(), "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reset replaces a linked .opencode folder without touching what it points at", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    const outside = join(root, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "keep.txt"), "keep")
    symlinkSync(outside, join(project, ".opencode"), "junction")
    resetWorktrees({ root, project })
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep")
    assert.equal(lstatSync(join(project, ".opencode")).isSymbolicLink(), false)
    assert.deepEqual(readdirSync(join(project, ".opencode")), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a failed Git cleanup rebuilds the fixture and reports the reason", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    gitIn(project, ["worktree", "add", "-qb", "worker", join(root, "worker")])
    writeFileSync(join(project, ".git/index.lock"), "left by a failed scenario")
    const failure = resetProject({ root, project })
    assert.match(failure, /rebuilt.*index\.lock/s)
    assert.equal(existsSync(join(root, "worker")), false)
    assert.equal(existsSync(join(project, "src/api/client.ts")), true)
    assert.equal(gitIn(project, ["branch", "--show-current"]).trim(), "main")
    assert.equal(gitIn(project, ["status", "--porcelain"]).trim(), "")
    assert.equal(resetProject({ root, project }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reset restores repository configuration changed by a scenario", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    const initialGitConfig = readFileSync(join(project, ".git/config"), "utf8")
    gitIn(project, ["config", "user.name", "Scenario author"])
    resetWorktrees({ root, project, initialGitConfig })
    assert.equal(readFileSync(join(project, ".git/config"), "utf8"), initialGitConfig)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("recovery removes registered worktrees even when Git cannot read its config", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    const worker = join(root, "worker")
    gitIn(project, ["worktree", "add", "-qb", "worker", worker])
    writeFileSync(join(project, ".git/config"), "invalid config\n")
    assert.match(resetProject({ root, project }), /rebuilt.*bad config/s)
    assert.equal(existsSync(worker), false)
    gitIn(project, ["worktree", "add", "-qb", "worker", worker])
    assert.equal(resetProject({ root, project }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("recovery recreates a project removed by a scenario", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-worktree-reset-"))
  try {
    const project = projectAt(root)
    rmSync(project, { recursive: true })
    assert.match(resetProject({ root, project }), /rebuilt/)
    assert.equal(existsSync(join(project, "src/api/client.ts")), true)
    assert.equal(resetProject({ root, project }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reset deletes every saved draft through the server and stops on a refused delete", async () => {
  const requests = []
  const stub = (answers) => {
    globalThis.fetch = async (url, init = {}) => {
      requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}`)
      return answers(init.method ?? "GET", new URL(url).pathname)
    }
  }
  const realFetch = globalThis.fetch
  try {
    stub((method) => method === "GET" ? Response.json({ drafts: [{ id: "a b" }, { id: "gone" }] }) : new Response(null, { status: requests.length === 3 ? 404 : 200 }))
    await deleteSavedDrafts("http://stand")
    assert.deepEqual(requests, ["GET /api/session-drafts", "DELETE /api/session-drafts/a%20b", "DELETE /api/session-drafts/gone"])
    stub((method) => method === "GET" ? Response.json({ drafts: [{ id: "a" }] }) : new Response(null, { status: 500 }))
    await assert.rejects(deleteSavedDrafts("http://stand"), /Deleting saved draft a answered 500/)
    stub(() => new Response(null, { status: 503 }))
    await assert.rejects(deleteSavedDrafts("http://stand"), /saved drafts answered 503/)
  } finally {
    globalThis.fetch = realFetch
  }
})
