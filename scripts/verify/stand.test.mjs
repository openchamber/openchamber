import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { gitIn, resetWorktrees } from "./stand.mjs"

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
