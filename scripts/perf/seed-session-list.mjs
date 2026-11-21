#!/usr/bin/env node
/**
 * Seeds a perf stand with the user's real session list, at full scale.
 *
 * The sidebar's cost scales with how many sessions, projects and worktrees the
 * user has, which a synthetic stand does not have. This copies the session
 * records (no messages, no parts) and project rows of the user's OpenCode
 * database into the stand's own HOME, with every path rewritten under the
 * stand root, so the stand's server cannot reach the user's repositories. It
 * creates each configured project as a repository carrying OpenCode's cached
 * project id, real git worktrees for OpenCode's worktree folders, plain
 * folders for every other session directory, and the stand's settings with the
 * user's projects. The user's database is opened read-only.
 *
 * Then: `bun run profile:serve -- --root <root>` and the profile:* commands
 * with `--dir <root>/project` (the user's first project).
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { DatabaseSync } from "node:sqlite"

const HELP = `Usage: node scripts/perf/seed-session-list.mjs --root <directory> [options]

Options:
  --root <directory>      Stand root (state/, project/, projects/, ext/); replaced
  --database <file>       OpenCode database to copy from
                          (default: ~/.local/share/opencode/opencode.db)
  --settings <file>       OpenChamber settings with the projects
                          (default: ~/.config/openchamber/settings.json)
  --help                  Show this help`

const parseArgs = (argv) => {
  const home = homedir()
  const options = {
    root: null,
    database: join(home, ".local/share/opencode/opencode.db"),
    settings: join(home, ".config/openchamber/settings.json"),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--root") options.root = resolve(argv[++index])
    else if (value === "--database") options.database = resolve(argv[++index])
    else if (value === "--settings") options.settings = resolve(argv[++index])
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!options.root) throw new Error("--root is required")
  return options
}

const STAND_MARKER = ".perf-stand"

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" })

const main = () => {
  const { root, database, settings: settingsFile } = parseArgs(process.argv.slice(2))
  const userHome = homedir()
  const state = join(root, "state")
  const home = join(state, "home")
  const ocData = join(state, "oc-data")
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"))
  const projects = settings.projects ?? []
  if (projects.length === 0) throw new Error(`${settingsFile} lists no projects`)

  // The root is replaced wholesale, so it must be a stand this script made (or
  // nothing yet) and must not hold what it copies from. It may sit inside a
  // project, such as a checkout's tmp/.
  const inside = (path, parent) => path === parent || path.startsWith(`${parent}/`)
  // Compared through symlinks: a source reached through one must not sit in the root.
  const canonical = (path) => {
    let existing = path
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
    return realpathSync(existing) + path.slice(existing.length)
  }
  const canonicalRoot = canonical(root)
  for (const path of [userHome, database, settingsFile, ...projects.map((project) => project.path)]) {
    if (inside(canonical(path), canonicalRoot)) throw new Error(`--root ${root} holds ${path}; pick a directory of its own`)
  }
  if (existsSync(root) && !existsSync(join(root, STAND_MARKER))) {
    throw new Error(`${root} exists and is not a stand this script made (no ${STAND_MARKER}); remove it yourself or pick another`)
  }
  // Read before anything is removed, so a bad source leaves the old stand in place.
  const source = new DatabaseSync(database, { readOnly: true })

  // Each project keeps its full path under the stand, so two projects with the
  // same folder name stay two repositories.
  const projectRoots = projects.map((project, index) => [
    project.path,
    index === 0 ? join(root, "project") : join(root, "projects", project.path.replace(/^\/+/, "")),
  ])

  const mapPath = (path) => {
    if (!path || path === "/") return path
    let best = null
    for (const [original, mapped] of projectRoots) {
      if (inside(path, original) && (!best || original.length > best[0].length)) best = [original, mapped]
    }
    if (best) return best[1] + path.slice(best[0].length)
    const config = join(userHome, ".config/openchamber")
    if (path === config || path.startsWith(`${config}/`)) return ocData + path.slice(config.length)
    if (path === userHome || path.startsWith(`${userHome}/`)) return home + path.slice(userHome.length)
    return join(root, "ext", path.replace(/^\/+/, ""))
  }

  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, STAND_MARKER), "Made by scripts/perf/seed-session-list.mjs; the next seed replaces this directory.\n")
  const dbDir = join(home, ".local/share/opencode")
  mkdirSync(dbDir, { recursive: true })
  mkdirSync(ocData, { recursive: true })

  const target = new DatabaseSync(join(dbDir, "opencode.db"))
  const schema = source.prepare("select sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by type = 'index', rowid").all()
  for (const { sql } of schema) target.exec(sql)

  const copy = (table, transform = (row) => row) => {
    let rows
    try { rows = source.prepare(`select * from ${table}`).all() } catch { return 0 }
    let count = 0
    target.exec("begin")
    for (const original of rows) {
      const row = transform({ ...original })
      const columns = Object.keys(row)
      target.prepare(`insert into ${table} (${columns.join(",")}) values (${columns.map(() => "?").join(",")})`).run(...columns.map((column) => row[column]))
      count += 1
    }
    target.exec("commit")
    return count
  }

  for (const table of ["__drizzle_migrations", "migration"]) copy(table)
  const projectCount = copy("project", (row) => {
    let sandboxes = []
    try { sandboxes = JSON.parse(row.sandboxes ?? "[]").map(mapPath) } catch { /* keep none */ }
    return { ...row, worktree: mapPath(row.worktree), sandboxes: JSON.stringify(sandboxes), icon_url: null, icon_url_override: null }
  })
  copy("project_directory", (row) => ({ ...row, directory: mapPath(row.directory) }))
  const directories = new Set()
  const sessionCount = copy("session_v2", (row) => {
    const directory = mapPath(row.directory)
    directories.add(directory)
    return { ...row, directory, workspace_id: null, share_url: null }
  })
  const projectIds = new Map(source.prepare("select worktree, id from project").all().map((row) => [row.worktree, row.id]))
  source.close()
  target.close()

  // Each configured project as a repository with OpenCode's cached id, so the
  // copied sessions keep their project.
  const standProjects = projects.map((project) => {
    const path = mapPath(project.path)
    mkdirSync(path, { recursive: true })
    if (!existsSync(join(path, ".git"))) {
      git(path, "init", "-q", "-b", "main")
      writeFileSync(join(path, "README.md"), "stand\n")
      git(path, "add", "README.md")
      git(path, "-c", "user.name=perf", "-c", "user.email=perf@example.invalid", "commit", "-qm", "init")
    }
    const id = projectIds.get(project.path)
    if (id) writeFileSync(join(path, ".git", "opencode"), id)
    const { icon: _icon, iconImage: _iconImage, ...rest } = project
    return { ...rest, path, id: `path_${Buffer.from(path).toString("base64url")}` }
  })

  // OpenCode's worktree folders become real worktrees of their project.
  const worktreeRoot = join(home, ".local/share/opencode/worktree")
  let worktrees = 0
  for (const directory of [...directories].sort()) {
    if (existsSync(directory)) continue
    if (directory.startsWith(`${worktreeRoot}/`)) {
      const [projectId, name] = directory.slice(worktreeRoot.length + 1).split("/")
      const owner = [...projectIds].find(([worktree, id]) => id === projectId && existsSync(join(mapPath(worktree), ".git")))
      if (owner && name) {
        try {
          git(mapPath(owner[0]), "worktree", "add", "-q", "-b", `wt/${name}`, directory)
          worktrees += 1
          continue
        } catch { /* a plain folder below */ }
      }
    }
    mkdirSync(directory, { recursive: true })
  }

  writeFileSync(join(ocData, "settings.json"), JSON.stringify({
    homeDirectory: home,
    projects: standProjects,
    activeProjectId: standProjects[0].id,
    lastDirectory: standProjects[0].path,
    defaultModel: "perf/stream-300cps",
  }, null, 2))
  console.log(`Seeded ${root}: ${sessionCount} sessions, ${projectCount} project rows, ${standProjects.length} projects, ${worktrees} worktrees, ${directories.size} session folders.`)
}

try {
  main()
} catch (error) {
  console.error(`seed-session-list failed: ${error.message}`)
  process.exitCode = 1
}
