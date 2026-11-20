import assert from "node:assert/strict"
import { test } from "node:test"

import { createSelector } from "./changed.mjs"
import { recordRequests } from "./requests.mjs"
import { matchRoute, routeTable } from "./server-routes.mjs"

test("a serving file answers the /api paths it names and the ones in the constants it imports", () => {
  const sources = new Map([
    ["routes.ts", "const SAVED = '/api/pages/saved'\napp.get('/api/config/commands/:name', read)\napp.post(`${SAVED}/:id/open`, open)\nrouter.use(['/api/git/', \"/api/fs/list?x\"], guard)"],
    ["stream.ts", "import { WS_PATH } from './paths.js'\nconst upgradeHandler = (req) => req.url === WS_PATH"],
    ["paths.ts", "export const WS_PATH = '/api/global/event/ws'"],
    ["client.ts", "export const url = '/api/config/commands'"],
  ])
  const importsOf = (file) => file === "stream.ts" ? ["paths.ts"] : []
  assert.deepEqual([...routeTable(sources, importsOf)], [
    ["routes.ts", ["/api/pages/saved", "/api/config/commands/:name", "/api/git", "/api/fs/list"]],
    ["stream.ts", ["/api/global/event/ws"]],
  ])
})

test("a requested path belongs to the most specific route that matches it", () => {
  const patterns = ["/api/config/commands/:name", "/api/config/commands/:name/config", "/api/config/:kind/:name", "/api/pages/saved", "/api/fs/*"]
  assert.equal(matchRoute("/api/config/commands/net-helper", patterns), "/api/config/commands/:name")
  assert.equal(matchRoute("/api/config/commands/net-helper/config", patterns), "/api/config/commands/:name/config")
  assert.equal(matchRoute("/api/pages/saved/42/open", patterns), "/api/pages/saved")
  assert.equal(matchRoute("/api/session/ses_1/message", patterns), null)
})

const scenariosOf = new Map([
  ["commands.edit", ["commands.edit.text", "commands.edit.blank"]],
  ["chat.send", ["chat.send.enter"]],
  ["git.stage", ["git.stage.one", "git.stage.all"]],
])
const patterns = ["/api/config/commands/:name", "/api/fs/read", "/api/config/settings", "/api/git/stage", "/api/git/unstage"]

test("recording keeps a feature's own requests and, once, the ones most features make", () => {
  const recorded = recordRequests({
    results: [
      { id: "commands.edit.text", ok: true, requests: ["PATCH /api/config/commands/a", "GET /api/session", "GET /api/config/settings"] },
      { id: "commands.edit.blank", ok: true, requests: ["GET /api/fs/read", "PUT@step /api/config/settings"] },
      { id: "chat.send.enter", ok: true, requests: ["GET /api/config/settings"] },
      { id: "git.stage.one", ok: true, requests: ["GET /api/config/settings", "POST /api/git/stage"] },
      { id: "git.stage.all", ok: true, requests: [] },
      { id: "git.stage.all", ok: false, requests: ["POST /api/git/unstage"] },
      { id: "gone.feature.one", ok: true, requests: ["GET /api/fs/read"] },
    ],
    scenariosOf,
    patterns,
    previous: { "*": [], "commands.edit": ["GET /api/old"], "removed.feature": ["GET /api/fs/read"] },
  })
  assert.deepEqual(recorded, {
    "*": ["GET /api/config/settings"],
    "chat.send": [],
    "commands.edit": ["GET /api/fs/read", "PATCH /api/config/commands/:name", "PUT@step /api/config/settings"],
    "git.stage": ["POST /api/git/stage"],
  })
})

test("a failed scenario or a part of a run adds to what a feature had and drops nothing", () => {
  const previous = { "*": ["GET /api/config/settings"], "git.stage": ["POST /api/git/stage"], "commands.edit": ["PATCH /api/config/commands/:name"], "chat.send": [] }
  const recorded = recordRequests({
    results: [
      { id: "git.stage.one", ok: false, requests: [] },
      { id: "git.stage.all", ok: true, requests: ["POST /api/git/unstage"] },
      { id: "commands.edit.text", ok: true },
      { id: "commands.edit.blank", ok: true },
    ],
    scenariosOf,
    patterns,
    previous,
  })
  assert.deepEqual(recorded["git.stage"], ["POST /api/git/stage", "POST /api/git/unstage"])
  assert.deepEqual(recorded["commands.edit"], previous["commands.edit"])
  assert.deepEqual(recorded["*"], previous["*"])
})

const repo = (tree) => ({
  read: (file) => tree[file] ?? null,
  isFile: (file) => file in tree,
  list: (dir) => Object.keys(tree).filter((file) => file.startsWith(dir)),
})

test("a changed server file selects the features that made requests to what it serves", () => {
  const zones = [
    { zone: "commands", sources: ["packages/ui/src/Commands.tsx"], features: [{ id: "edit", scenarios: [] }] },
    { zone: "git", sources: ["packages/ui/src/Git.tsx"], features: [{ id: "stage", scenarios: [] }, { id: "push", scenarios: [] }] },
    { zone: "workspace", sources: ["packages/ui/src/Workspace.tsx"], features: [{ id: "font", sources: ["packages/web/server/lib/git/service.ts"], scenarios: [] }] },
  ]
  const server = "packages/web/server/"
  const tree = {
    "packages/ui/src/Commands.tsx": "",
    "packages/ui/src/Git.tsx": "",
    "packages/ui/src/Workspace.tsx": "",
    [`${server}runtime.ts`]: "import './lib/commands/routes.js'\nimport './lib/git/routes.js'\nimport './lib/settings/routes.js'\nimport './lib/stream.js'\nimport './lib/health/routes.js'\nimport './lib/idle.js'\napp.get('/api/health', ok)",
    [`${server}lib/commands/routes.ts`]: "import type * as store from './store.js'\napp.patch('/api/config/commands/:name', write)",
    [`${server}lib/commands/store.ts`]: "import '../shared/guards.js'",
    [`${server}lib/git/routes.ts`]: "import '../shared/guards.js'\nimport './service.js'\napp.post('/api/git/stage', stage)",
    [`${server}lib/git/service.ts`]: "",
    [`${server}lib/shared/guards.ts`]: "",
    [`${server}lib/settings/routes.ts`]: "app.get('/api/config/settings', read)\napp.put('/api/config/settings', write)",
    [`${server}lib/stream.ts`]: "const upgradeHandler = (req) => req.url === '/api/global/event/ws' || req.url === '/api/git/stage'",
    [`${server}lib/idle.ts`]: "",
    [`${server}lib/health/routes.ts`]: "app.get('/api/health/ready', ok)",
  }
  const recorded = {
    "*": ["GET /api/config/settings", "GET /api/health/ready", "WS /api/global/event/ws"],
    "commands.edit": ["PATCH /api/config/commands/:name"],
    "git.stage": ["POST /api/git/stage"],
    "workspace.font": ["PUT /api/config/settings"],
    "removed.feature": ["POST /api/git/stage"],
  }
  const explain = (file, files = repo(tree)) => createSelector(zones, files, recorded).explain([file], { features: new Set(), names: new Set() })[0]
  assert.deepEqual(explain(`${server}lib/commands/store.ts`), { file: `${server}lib/commands/store.ts`, reason: "routes", features: ["commands.edit"], routeFiles: [`${server}lib/commands/routes.ts`] })
  assert.deepEqual(explain(`${server}lib/shared/guards.ts`).features, ["commands.edit", "git.stage"])
  // A feature that lists the file keeps it next to the ones that request its routes.
  assert.deepEqual(explain(`${server}lib/git/service.ts`).features, ["git.stage", "workspace.font"])
  // The write is one feature's; the read every page makes does not widen it.
  assert.deepEqual(explain(`${server}lib/settings/routes.ts`).features, ["workspace.font"])
  // The socket every page holds open: every scenario plays it, whatever else the file serves.
  assert.equal(explain(`${server}lib/stream.ts`).reason, "server")
  assert.equal(explain(`${server}runtime.ts`).reason, "server")
  assert.deepEqual(explain(`${server}runtime.ts`).features, ["commands.edit", "git.stage", "git.push", "workspace.font"])
  assert.equal(explain(`${server}lib/idle.ts`).reason, "uncovered")
  // Nothing but a read every page makes.
  assert.equal(explain(`${server}lib/health/routes.ts`).reason, "server")
  // A deleted route file names no routes any more, so nothing narrows it.
  const { [`${server}lib/commands/routes.ts`]: _deleted, ...without } = tree
  assert.equal(explain(`${server}lib/commands/routes.ts`, { ...repo(without), isFile: (file) => file in tree }).reason, "server")
  assert.equal(createSelector(zones, repo(tree)).explain([`${server}lib/commands/store.ts`], { features: new Set(), names: new Set() })[0].reason, "uncovered")
  assert.equal(explain("scripts/verify/requests.json").reason, "not-app")
})
