// Which scenarios a change can break: maps changed files to the features whose
// sources hold them or import them. Pure over injected file access, so the
// selection is tested without a stand (`changed.test.mjs`). Why it works this
// way is in DOCUMENTATION.md (*Running only what a change touches*).

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, posix } from "node:path"

import { SERVER_ROOT, createServerSelector, routeTable } from "./server-routes.mjs"

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const TEST_FILE = /(\.(test|spec|vitest|bench)\.[cm]?[jt]sx?$|\/(__tests__|__mocks__)\/)/
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"])

/** Where the app's import aliases point (packages/web/vite.config.ts, the tsconfigs), longest prefix first. */
const ALIASES = [
  ["@openchamber/sdk/schemas", ["packages/sdk/src/schemas.ts"]],
  ["@openchamber/sdk", ["packages/sdk/src/index.ts"]],
  ["@openchamber/ui/", ["packages/ui/src/"]],
  ["@web/", ["packages/web/src/"]],
  ["@/", ["packages/ui/src/", "packages/web/src/"]],
]

/**
 * State and libraries every part of the app loads. They import each other in
 * cycles, so a walk that follows them reaches every store from any component.
 * The walk takes the ones a feature's own code imports and goes no further
 * (DOCUMENTATION.md, *Why the walk stops at the first store or library*).
 */
const SHARED_LAYER = /^packages\/ui\/src\/(stores|sync|lib)\//

/** The net itself: a change to its runner or fixtures can break any scenario. */
const NET_ROOT = "scripts/verify/"
const ZONE_FILE = /^scripts\/verify\/zones\/([^/]+)\.json$/
const VOCABULARY_FILE = "scripts/verify/vocabulary.json"
const REQUESTS_FILE = "scripts/verify/requests.json"

/** Every vocabulary name a feature's steps point at. */
const vocabularyNames = (feature) => new Set(feature.scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => [step.on, step.to?.on].filter(Boolean))))

/**
 * What changed in the feature map between two versions of it (`{ zones,
 * vocabulary }`): the features whose scenarios differ or are new, and the
 * vocabulary names whose selector differs, is new or is gone. A feature's
 * texts and sources run nothing.
 */
export const diffMap = (before, after) => {
  const scenariosById = (zones) => new Map(zones.flatMap((zone) => zone.features.map((feature) => [`${zone.zone}.${feature.id}`, JSON.stringify(feature.scenarios)])))
  const was = scenariosById(before.zones)
  const features = new Set([...scenariosById(after.zones)].filter(([id, scenarios]) => was.get(id) !== scenarios).map(([id]) => id))
  const names = new Set([...Object.keys(before.vocabulary), ...Object.keys(after.vocabulary)]
    .filter((name) => JSON.stringify(before.vocabulary[name]) !== JSON.stringify(after.vocabulary[name])))
  return { features, names }
}

/**
 * Module specifiers a file loads at run time: static imports and re-exports,
 * side-effect imports, dynamic `import("…")` and `require("…")`. Type-only
 * imports and re-exports are left out, since they change no behavior;
 * `withTypes` keeps them, for code that receives its modules as arguments
 * and names them only by type.
 */
export const parseImports = (source, { withTypes = false } = {}) => {
  const specifiers = new Set()
  for (const match of source.matchAll(/^\s*(?:import|export)\s+([^;'"()=]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (withTypes || !/^type\s/.test(match[1])) specifiers.add(match[2])
  }
  for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specifiers.add(match[1])
  for (const match of source.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1])
  return [...specifiers]
}

/** Repo-relative candidates for a specifier, before checking which exists. */
const candidateBases = (specifier, fromFile) => {
  if (specifier.startsWith(".")) return [posix.join(posix.dirname(fromFile), specifier)]
  for (const [prefix, targets] of ALIASES) {
    if (specifier === prefix || (prefix.endsWith("/") && specifier.startsWith(prefix))) {
      return targets.map((target) => target.endsWith("/") ? target + specifier.slice(prefix.length) : target)
    }
  }
  return []
}

/** The repo file a specifier loads, or null for a package or a path that does not exist. */
export const resolveImport = (specifier, fromFile, isFile) => {
  for (const base of candidateBases(specifier, fromFile)) {
    const stems = /\.[cm]?js$/.test(base) ? [base, base.replace(/\.[cm]?js$/, "")] : [base]
    for (const stem of stems) {
      for (const suffix of RESOLVE_SUFFIXES) {
        if (isFile(stem + suffix)) return stem + suffix
      }
    }
  }
  return null
}

const matchesSource = (file, source) => source.endsWith("/") ? file.startsWith(source) : file === source

/**
 * Selection over the feature map. `files` gives repo access: `read(path)` the
 * text or null, `isFile(path)`, `list(dir)` every file under a directory.
 */
export const createSelector = (zones, files, recorded = {}) => {
  const features = zones.flatMap((zone) => zone.features.map((feature) => ({
    id: `${zone.zone}.${feature.id}`,
    names: vocabularyNames(feature),
    // A feature naming no sources of its own is selected by its zone's.
    sources: feature.sources ?? zone.sources,
  })))

  const ownersCache = new Map()
  const owners = (file) => {
    if (!ownersCache.has(file)) ownersCache.set(file, features.filter((feature) => feature.sources.some((source) => matchesSource(file, source))))
    return ownersCache.get(file)
  }

  const importsCache = new Map()
  const importsOf = (file) => {
    if (!importsCache.has(file)) {
      const text = files.read(file)
      importsCache.set(file, text === null ? [] : parseImports(text)
        .map((specifier) => resolveImport(specifier, file, files.isFile))
        .filter((target) => target !== null))
    }
    return importsCache.get(file)
  }

  const rootFiles = (sources) => sources.flatMap((source) => source.endsWith("/") ? files.list(source) : [source])
    .filter((file) => CODE_FILE.test(file) && !TEST_FILE.test(file))

  // The files a feature's sources load: every component and hook on the way,
  // and the stores and libraries those import, not what they import in turn.
  // The walk does not enter a file another feature lists: that file's
  // behavior is that feature's to catch.
  const reached = new Map()
  for (const feature of features) {
    const seen = new Set(rootFiles(feature.sources))
    const queue = [...seen]
    while (queue.length) {
      for (const target of importsOf(queue.pop())) {
        if (seen.has(target)) continue
        const listedBy = owners(target)
        if (listedBy.length && !listedBy.includes(feature)) continue
        seen.add(target)
        if (!SHARED_LAYER.test(target)) queue.push(target)
      }
    }
    reached.set(feature.id, seen)
  }

  // The files the net runs: scripts/verify and what it loads from scripts/
  // (the fixtures, the isolated server). App code it reads stays the features'.
  const netFiles = new Set(rootFiles([NET_ROOT]))
  const netQueue = [...netFiles]
  while (netQueue.length) {
    for (const target of importsOf(netQueue.pop())) {
      if (!netFiles.has(target) && target.startsWith("scripts/")) { netFiles.add(target); netQueue.push(target) }
    }
  }
  const everyFeature = features.map((feature) => feature.id)

  let serverSelector = null
  const selectByRoutes = (file) => {
    // A deleted server file: what it served is gone from the tree, so nothing narrows it.
    if (files.read(file) === null) return { whole: true, routeFiles: [], features: [] }
    if (!serverSelector) {
      const sources = new Map(rootFiles([SERVER_ROOT]).map((serverFile) => [serverFile, files.read(serverFile) ?? ""]))
      // A route file is handed the modules it calls and imports only their types.
      const loads = new Map()
      const serverImportsOf = (serverFile) => {
        if (!loads.has(serverFile)) {
          loads.set(serverFile, parseImports(sources.get(serverFile) ?? files.read(serverFile) ?? "", { withTypes: true })
            .map((specifier) => resolveImport(specifier, serverFile, files.isFile))
            .filter((target) => target !== null))
        }
        return loads.get(serverFile)
      }
      serverSelector = createServerSelector({
        routes: routeTable(sources, serverImportsOf),
        importsOf: serverImportsOf,
        recorded: Object.fromEntries(Object.entries(recorded).filter(([id]) => id === "*" || everyFeature.includes(id))),
      })
    }
    return serverSelector(file)
  }

  /**
   * For each changed file, why it selects what it selects. `reason` is one of
   * `net` (the runner or a fixture: everything), `scenarios` (a zone file: the
   * features whose scenarios changed), `vocabulary` (the features using a
   * name whose selector changed), `listed` (in a feature's sources),
   * `imported` (loaded by those sources), `shared` (loaded by more than half
   * the features: everything), `routes` (a server file: the features whose
   * scenarios requested the routes it serves), `server` (the server's own
   * wiring: everything), `not-app` (tests, docs, files outside
   * packages/) or `uncovered` (app code no scenario plays). `mapChanges` is
   * what `diffMap` found between the map at the base and now.
   */
  const explain = (changedFiles, mapChanges) => changedFiles.map((file) => {
    if (file.endsWith(".md") || TEST_FILE.test(file)) return { file, reason: "not-app", features: [] }
    if (ZONE_FILE.test(file)) {
      return { file, reason: "scenarios", features: everyFeature.filter((id) => id.startsWith(`${file.match(ZONE_FILE)[1]}.`) && mapChanges.features.has(id)) }
    }
    if (file === VOCABULARY_FILE) {
      return { file, reason: "vocabulary", features: features.filter((feature) => [...feature.names].some((name) => mapChanges.names.has(name))).map((feature) => feature.id) }
    }
    // Written by a full run from what its scenarios requested; it plays nothing itself.
    if (file === REQUESTS_FILE) return { file, reason: "not-app", features: [] }
    if (file.startsWith(NET_ROOT) || netFiles.has(file)) return { file, reason: "net", features: everyFeature }
    if (!file.startsWith("packages/") || file.startsWith("packages/docs/")) return { file, reason: "not-app", features: [] }
    const listedBy = owners(file)
    const importedBy = listedBy.length ? [] : features.filter((feature) => reached.get(feature.id).has(file))
    // A server file is also played by whoever requests the routes it serves,
    // whatever lists or imports it.
    const served = file.startsWith(SERVER_ROOT) && CODE_FILE.test(file) ? selectByRoutes(file) : null
    if (served?.whole) return { file, reason: "server", features: everyFeature }
    if (served?.features.length) {
      const also = new Set([...listedBy, ...importedBy].map((feature) => feature.id))
      return { file, reason: "routes", features: everyFeature.filter((id) => also.has(id) || served.features.includes(id)), routeFiles: served.routeFiles }
    }
    if (listedBy.length) return { file, reason: "listed", features: listedBy.map((feature) => feature.id) }
    if (importedBy.length * 2 > features.length) return { file, reason: "shared", features: everyFeature, importers: importedBy.length, total: features.length }
    if (importedBy.length) return { file, reason: "imported", features: importedBy.map((feature) => feature.id) }
    return { file, reason: "uncovered", features: [] }
  })

  return { explain }
}

/**
 * Repo access where the change's files still resolve as imports, so a file the
 * change deleted stays reachable from the code that imports it and selects
 * that code's features.
 */
export const keepingChangedFiles = (files, changedFiles) => {
  const changed = new Set(changedFiles)
  return { ...files, isFile: (file) => files.isFile(file) || changed.has(file) }
}

/** The recorded requests per feature in the working tree; empty when none were recorded. */
export const readRecordedRequests = (repoRoot) => {
  try { return JSON.parse(readFileSync(join(repoRoot, REQUESTS_FILE), "utf8")) } catch { return {} }
}

/** Repo access over the working tree. */
export const workingTreeFiles = (repoRoot) => ({
  read: (file) => { try { return readFileSync(join(repoRoot, file), "utf8") } catch { return null } },
  isFile: (file) => { try { return statSync(join(repoRoot, file)).isFile() } catch { return false } },
  list: (dir) => {
    const found = []
    const walk = (relativeDir) => {
      if (!existsSync(join(repoRoot, relativeDir))) return
      for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
        const path = `${relativeDir}${entry.name}`
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(`${path}/`) } else found.push(path)
      }
    }
    walk(dir.endsWith("/") ? dir : `${dir}/`)
    return found
  },
})

/**
 * Files the change touches, as `bun run check:changed` counts them: from where
 * the branch left origin/main, with uncommitted and new files. A range
 * (`A..B`) takes the files between two commits only. Deletions and both sides
 * of a rename count, since a deleted source is a changed one.
 */
export const listChangedFiles = (repoRoot, base) => {
  const git = gitIn(repoRoot)
  if (base?.includes("..")) {
    const [from, to] = base.split("..")
    return { label: base, from, to: to || "HEAD", files: [...new Set(lines(git(["diff", "--name-only", "--no-renames", from, to || "HEAD"])))] }
  }
  const from = base ?? git(["merge-base", "HEAD", "origin/main"]).trim()
  const tracked = lines(git(["diff", "--name-only", "--no-renames", from]))
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]))
  return { label: from, from, to: null, files: [...new Set([...tracked, ...untracked])] }
}

/** The feature map as a commit has it; empty where the commit has none. */
export const readMapAt = (repoRoot, ref) => {
  const git = gitIn(repoRoot)
  const show = (file) => { try { return JSON.parse(git(["show", `${ref}:${file}`])) } catch { return null } }
  const zoneFiles = lines(git(["ls-tree", "--name-only", `${ref}`, "scripts/verify/zones/"])).filter((file) => file.endsWith(".json"))
  return { vocabulary: show(VOCABULARY_FILE) ?? {}, zones: zoneFiles.map(show).filter(Boolean) }
}

const gitIn = (repoRoot) => (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
const lines = (text) => text.split(/\r?\n/).filter(Boolean)
