#!/usr/bin/env node
// Writes requests.json: for each feature, the server routes its scenarios
// requested in the runs given as artifact folders (several when a run was
// played in parts). `--changed` selects by it for a changed server file.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"

import { workingTreeFiles } from "./changed.mjs"
import { SERVER_ROOT, apiPathsIn, matchRoute } from "./server-routes.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "../..")

/** Every result.json under a folder, at any depth. */
const resultsUnder = (folder) => readdirSync(folder, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && entry.name === "result.json")
  .map((entry) => JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")))

export const EVERY_FEATURE = "*"

/**
 * `{ "*": requests most features made, feature id: its other requests }` from
 * scenario results, each request as `METHOD pattern`, sorted. Every page reads
 * its settings, the session list and the like when it loads; a request more
 * than half the features made says nothing about which of them plays it, so it
 * is kept once under `*`. `scenariosOf` maps each feature to its scenario ids:
 * a feature all of whose scenarios passed here is recorded anew, and any other
 * keeps what `previous` had and adds what was seen, so a part of a run or a
 * failed scenario never drops a route. A result without `requests` comes from
 * a run that did not record and counts as not played. `PUT@step` marks a
 * request a step made for the scenario from outside the page.
 */
export const recordRequests = ({ results, scenariosOf, patterns, previous = {} }) => {
  const featureOf = new Map([...scenariosOf].flatMap(([feature, scenarios]) => scenarios.map((scenario) => [scenario, feature])))
  const { [EVERY_FEATURE]: shared = [], ...kept } = previous
  const passed = new Set(results.filter((result) => result.ok && Array.isArray(result.requests)).map((result) => result.id))
  const byFeature = new Map()
  for (const [feature, scenarios] of scenariosOf) {
    const complete = scenarios.every((scenario) => passed.has(scenario))
    if (complete) byFeature.set(feature, new Set())
    else if (kept[feature]) byFeature.set(feature, new Set([...shared, ...kept[feature]]))
  }
  for (const result of results) {
    const feature = featureOf.get(result.id)
    // A failed attempt of a scenario that passed when played again asked for
    // what only its failure needed.
    if (!feature || (!result.ok && passed.has(result.id))) continue
    const requests = byFeature.get(feature) ?? byFeature.set(feature, new Set()).get(feature)
    for (const request of result.requests ?? []) {
      const [method, path] = request.split(" ")
      const pattern = matchRoute(path ?? "", patterns)
      if (pattern) requests.add(`${method} ${pattern}`)
    }
  }
  const madeBy = new Map()
  for (const requests of byFeature.values()) for (const request of requests) madeBy.set(request, (madeBy.get(request) ?? 0) + 1)
  const everywhere = new Set([...madeBy].filter(([, count]) => count * 2 > byFeature.size).map(([request]) => request))
  return Object.fromEntries([
    [EVERY_FEATURE, [...everywhere].sort()],
    ...[...byFeature].sort(([a], [b]) => a.localeCompare(b)).map(([feature, requests]) => [feature, [...requests].filter((request) => !everywhere.has(request)).sort()]),
  ])
}

const main = () => {
  const folders = process.argv.slice(2)
  if (!folders.length) throw new Error("Usage: node scripts/verify/requests.mjs <run artifacts folder>...")
  const missing = folders.filter((folder) => !existsSync(folder))
  if (missing.length) throw new Error(`No such folder: ${missing.join(", ")}`)
  const files = workingTreeFiles(REPO_ROOT)
  const patterns = [...new Set(files.list(SERVER_ROOT).filter((file) => /\.[cm]?[jt]s$/.test(file) && !/\.test\./.test(file)).flatMap((file) => apiPathsIn(files.read(file) ?? "")))]
  const zones = readdirSync(join(HERE, "zones")).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(HERE, "zones", file), "utf8")))
  const scenariosOf = new Map(zones.flatMap((zone) => zone.features.map((feature) => [`${zone.zone}.${feature.id}`, feature.scenarios.map((scenario) => `${zone.zone}.${feature.id}.${scenario.id}`)])))
  const target = join(HERE, "requests.json")
  const previous = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {}
  const results = folders.flatMap(resultsUnder)
  const recorded = recordRequests({ results, scenariosOf, patterns, previous })
  writeFileSync(target, `${JSON.stringify(recorded, null, 2)}\n`)
  const ids = new Set(results.map((result) => result.id))
  const played = [...scenariosOf].filter(([, scenarios]) => scenarios.some((scenario) => ids.has(scenario))).length
  console.log(`requests.json: ${Object.keys(recorded).length - 1} features, ${recorded[EVERY_FEATURE].length} requests most of them make, ${played} of ${scenariosOf.size} features played in these runs, ${results.length} scenario results`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(`[verify] ${error.message}`); process.exitCode = 2 }
}
