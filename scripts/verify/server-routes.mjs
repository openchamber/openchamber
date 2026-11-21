// Which scenarios a changed server file can break. The UI reaches the server
// over HTTP, so no import leads from a feature's sources to the server's code.
// A full run records the `/api` paths each scenario asks for (`requests.json`);
// here those meet the routes each server file registers. Why it works this way
// is in DOCUMENTATION.md (*Why server files are selected by recorded requests*).

export const SERVER_ROOT = "packages/web/server/"

const REGISTERS_ROUTES = /\b\w+\.(?:get|post|put|patch|delete|all|use)\s*(?:<[^()]*>)?\(|\bupgradeHandler\b|\.on\(\s*["']upgrade["']/
const API_LITERAL = /["'`](\/api(?:\/[^"'`\s?#$]*)?)/g

/** Whether a server file answers requests itself: it registers routes or handles WebSocket upgrades. */
export const servesRequests = (source) => REGISTERS_ROUTES.test(source)

/** The `/api` paths a file names; a `:name` or `*` segment stands for any one. */
export const apiPathsIn = (source) => [...new Set([...source.matchAll(API_LITERAL)].map((match) => match[1].replace(/\/+$/, "")).filter((pattern) => pattern.length > "/api".length))]

/**
 * Each serving file with the paths it answers: the ones it names, and the
 * ones named by a file it imports that serves nothing itself, where shared
 * path constants live. `sources` maps a server file to its text, `importsOf`
 * gives the files a file loads.
 */
export const routeTable = (sources, importsOf) => {
  const serving = new Set([...sources].filter(([, source]) => servesRequests(source)).map(([file]) => file))
  return new Map([...serving].map((file) => [file, [...new Set([
    ...apiPathsIn(sources.get(file)),
    ...importsOf(file).filter((target) => sources.has(target) && !serving.has(target)).flatMap((target) => apiPathsIn(sources.get(target))),
  ])]]).filter(([, patterns]) => patterns.length))
}

const segmentsOf = (path) => path.split("/").filter(Boolean)
const isWildcard = (segment) => segment.startsWith(":") || segment.includes("*")

/**
 * The pattern a requested path belongs to: one that matches every segment, or
 * else the longest that matches the path's start (a route built from a named
 * prefix). Fixed segments beat wildcards. Null when the server names no such
 * path, as for the requests it passes on to OpenCode.
 */
export const matchRoute = (path, patterns) => {
  const wanted = segmentsOf(path)
  let best = null
  for (const pattern of patterns) {
    const parts = segmentsOf(pattern)
    if (parts.length > wanted.length || !parts.every((part, index) => isWildcard(part) || part === wanted[index])) continue
    const score = (parts.length === wanted.length ? 1000 : 0) + parts.length * 10 + parts.filter((part) => !isWildcard(part)).length
    if (!best || score > best.score) best = { pattern, score }
  }
  return best?.pattern ?? null
}

const routeOf = (request) => request.slice(request.indexOf(" ") + 1)

/**
 * Selection of features by server file. `routes` maps each serving file to
 * its patterns (`routeTable`), `importsOf(file)` gives the repo files a file
 * loads, `recorded` maps a feature id to the requests its scenarios made, as
 * `METHOD pattern`, and `*` to the requests most features made.
 */
export const createServerSelector = ({ routes, importsOf, recorded }) => {
  const loadedCache = new Map()
  const loadedBy = (file) => {
    if (!loadedCache.has(file)) {
      const seen = new Set([file])
      const queue = [file]
      while (queue.length) {
        for (const target of importsOf(queue.pop())) {
          if (!seen.has(target) && target.startsWith(SERVER_ROOT)) { seen.add(target); queue.push(target) }
        }
      }
      loadedCache.set(file, seen)
    }
    return loadedCache.get(file)
  }
  const routeFiles = [...routes.keys()]
  const { "*": everywhere = [], ...byFeature } = recorded
  const requested = (requests, patterns) => requests.some((request) => patterns.has(routeOf(request)))
  const isWiring = (file) => routeFiles.filter((routeFile) => loadedBy(file).has(routeFile)).length * 2 > routeFiles.length

  /**
   * `null` for a file no serving file loads. Otherwise the serving files that
   * load it and the features that made requests to their paths. `whole` when
   * every scenario plays the file: it loads most serving files, so it is the
   * server's own wiring, it answers nothing but requests most features make,
   * or it serves itself a socket most of them hold open.
   */
  return (file) => {
    if (isWiring(file)) return { whole: true, routeFiles: [], features: [] }
    const through = routeFiles.filter((routeFile) => loadedBy(routeFile).has(file) && !isWiring(routeFile))
    if (!through.length) return null
    const patterns = new Set(through.flatMap((routeFile) => routes.get(routeFile)))
    const features = Object.entries(byFeature).filter(([, requests]) => requested(requests, patterns)).map(([id]) => id)
    // A socket most features hold open carries every page's live updates.
    const liveForAll = requested(everywhere.filter((request) => request.startsWith("WS ")), new Set(routes.get(file) ?? []))
    return { whole: liveForAll || (!features.length && requested(everywhere, patterns)), routeFiles: through, features }
  }
}
