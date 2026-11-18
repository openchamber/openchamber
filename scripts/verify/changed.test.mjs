import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { createSelector, diffMap, keepingChangedFiles, parseImports, resolveImport } from "./changed.mjs"

/** Repo access over an in-memory tree: `{ "path": "text" }`. */
const memoryFiles = (tree) => ({
  read: (file) => tree[file] ?? null,
  isFile: (file) => file in tree,
  list: (dir) => Object.keys(tree).filter((file) => file.startsWith(dir)),
})

const feature = (id, sources, steps = []) => {
  const made = { id, scenarios: [{ id: "one", steps }] }
  if (sources) made.sources = sources
  return made
}
const zone = (name, sources, features) => ({ zone: name, sources, features })

const NO_MAP_CHANGES = { features: new Set(), names: new Set() }
const pick = (selector, files, mapChanges = NO_MAP_CHANGES) => Object.fromEntries(selector.explain(files, mapChanges).map((entry) => [entry.file, { reason: entry.reason, features: entry.features }]))

test("settings scenarios are selected for the code that applies their choices", () => {
  const settings = JSON.parse(readFileSync(new URL("./zones/openchamber.json", import.meta.url), "utf8"))
  const cases = [
    ["packages/ui/src/contexts/ThemeSystemContext.tsx", "openchamber.themes"],
    ["packages/ui/src/components/chat/composer/keyboardPolicy.ts", "openchamber.chat"],
    ["packages/ui/src/components/chat/composer/input/createComposerKeyHandler.ts", "openchamber.chat"],
  ]
  const tree = Object.fromEntries(cases.map(([file]) => [file, ""]))
  const selector = createSelector([settings], memoryFiles(tree))
  for (const [file, expected] of cases) {
    assert.ok(selector.explain([file], NO_MAP_CHANGES)[0].features.includes(expected), `${file} must select ${expected}`)
  }
})

test("runtime imports are read; type-only ones are not", () => {
  const source = [
    'import { a } from "./a"',
    'import type { B } from "./b"',
    "import {",
    "  type C,",
    "  d,",
    '} from "@/stores/d"',
    'export { e } from "./e"',
    'export type { F } from "./f"',
    'export * from "./g"',
    'import "./side-effect.css"',
    'const Lazy = lazy(() => import("./Lazy"))',
    'export const from = "./not-an-import"',
  ].join("\n")
  assert.deepEqual(parseImports(source).sort(), ["./Lazy", "./a", "./e", "./g", "./side-effect.css", "@/stores/d"])
})

test("specifiers resolve through the app's aliases, extensions and index files", () => {
  const tree = new Set([
    "packages/ui/src/stores/useThing.ts",
    "packages/ui/src/lib/dir/index.ts",
    "packages/web/src/only-web.tsx",
    "packages/web/server/lib/a.js",
    "packages/sdk/src/index.ts",
  ])
  const isFile = (file) => tree.has(file)
  const from = "packages/ui/src/components/X.tsx"
  assert.equal(resolveImport("@/stores/useThing", from, isFile), "packages/ui/src/stores/useThing.ts")
  assert.equal(resolveImport("@openchamber/ui/lib/dir", from, isFile), "packages/ui/src/lib/dir/index.ts")
  assert.equal(resolveImport("@/only-web", "packages/web/src/main.tsx", isFile), "packages/web/src/only-web.tsx")
  assert.equal(resolveImport("../stores/useThing.js", from, isFile), "packages/ui/src/stores/useThing.ts")
  assert.equal(resolveImport("./a.js", "packages/web/server/lib/b.js", isFile), "packages/web/server/lib/a.js")
  assert.equal(resolveImport("@openchamber/sdk", from, isFile), "packages/sdk/src/index.ts")
  assert.equal(resolveImport("react", from, isFile), null)
})

const UI = "packages/ui/src/"

/** A chat zone split into features, a composer zone without, and shared code under them. */
const repo = () => ({
  [`${UI}chat/Transcript.tsx`]: 'import { Footer } from "./Footer"\nimport { useTurns } from "@/stores/turns"\nimport { ChatInput } from "./ChatInput"',
  [`${UI}chat/Footer.tsx`]: 'import { formatCost } from "./footerFormat"\nimport { useTurns } from "@/stores/turns"',
  [`${UI}chat/footerFormat.ts`]: 'import { formatCost } from "@/lib/cost"',
  [`${UI}chat/WorkStatus.tsx`]: 'import { statusLabel } from "@/lib/status"',
  [`${UI}chat/ChatInput.tsx`]: 'import { useDraft } from "@/stores/draft"\nimport { useTurns } from "@/stores/turns"',
  [`${UI}chat/Unplayed.tsx`]: 'import { x } from "@/lib/unplayed"',
  [`${UI}chat/Footer.test.tsx`]: 'import { Footer } from "./Footer"',
  [`${UI}lib/cost.ts`]: 'import { round } from "./math"',
  [`${UI}lib/math.ts`]: "",
  [`${UI}lib/status.ts`]: "",
  [`${UI}lib/unplayed.ts`]: "",
  [`${UI}stores/turns.ts`]: "",
  [`${UI}stores/draft.ts`]: "",
  "scripts/verify/run.mjs": 'import { startFixture } from "../perf/fixture.mjs"',
  "scripts/perf/fixture.mjs": "",
  "scripts/perf/unrelated.mjs": "",
})

const zones = () => [
  zone("chat", [`${UI}chat/Transcript.tsx`, `${UI}chat/Footer.tsx`, `${UI}chat/WorkStatus.tsx`], [
    feature("history", [`${UI}chat/Transcript.tsx`]),
    feature("footer", [`${UI}chat/Transcript.tsx`, `${UI}chat/Footer.tsx`]),
    feature("work-status", [`${UI}chat/WorkStatus.tsx`]),
  ]),
  zone("composer", [`${UI}chat/ChatInput.tsx`], [feature("send"), feature("draft")]),
]

test("a file a feature lists selects that feature only, and a feature without sources is selected by its zone's", () => {
  const selector = createSelector(zones(), memoryFiles(repo()))
  assert.deepEqual(pick(selector, [`${UI}chat/WorkStatus.tsx`, `${UI}chat/Footer.tsx`, `${UI}chat/ChatInput.tsx`]), {
    [`${UI}chat/WorkStatus.tsx`]: { reason: "listed", features: ["chat.work-status"] },
    [`${UI}chat/Footer.tsx`]: { reason: "listed", features: ["chat.footer"] },
    [`${UI}chat/ChatInput.tsx`]: { reason: "listed", features: ["composer.send", "composer.draft"] },
  })
})

test("a shared file selects the features whose code imports it, through their components and hooks", () => {
  const selector = createSelector(zones(), memoryFiles(repo()))
  assert.deepEqual(pick(selector, [`${UI}chat/footerFormat.ts`, `${UI}lib/cost.ts`, `${UI}lib/status.ts`]), {
    [`${UI}chat/footerFormat.ts`]: { reason: "imported", features: ["chat.footer"] },
    [`${UI}lib/cost.ts`]: { reason: "imported", features: ["chat.footer"] },
    [`${UI}lib/status.ts`]: { reason: "imported", features: ["chat.work-status"] },
  })
})

test("the walk stops at the first store or library: what a library imports is not followed", () => {
  const selector = createSelector(zones(), memoryFiles(repo()))
  assert.deepEqual(pick(selector, [`${UI}lib/math.ts`]), { [`${UI}lib/math.ts`]: { reason: "uncovered", features: [] } })
})

test("the import walk stops at a file another feature lists", () => {
  // Transcript imports ChatInput, which the composer lists: the draft store
  // behind it is the composer's to catch, not the transcript's.
  const selector = createSelector(zones(), memoryFiles(repo()))
  assert.deepEqual(pick(selector, [`${UI}stores/draft.ts`]), {
    [`${UI}stores/draft.ts`]: { reason: "imported", features: ["composer.send", "composer.draft"] },
  })
})

test("a file more than half the features import runs everything, and says so", () => {
  const selector = createSelector(zones(), memoryFiles(repo()))
  const [entry] = selector.explain([`${UI}stores/turns.ts`])
  assert.equal(entry.reason, "shared")
  assert.equal(entry.features.length, 5)
  assert.equal(entry.importers, 4)
  assert.equal(entry.total, 5)
})

test("exactly half is not more than half", () => {
  const tree = { ...repo(), [`${UI}chat/WorkStatus.tsx`]: 'import { useTurns } from "@/stores/turns"', [`${UI}chat/ChatInput.tsx`]: "" }
  const four = [zone("chat", [], [feature("a", [`${UI}chat/Footer.tsx`]), feature("b", [`${UI}chat/WorkStatus.tsx`]), feature("c", [`${UI}chat/ChatInput.tsx`]), feature("d", [`${UI}chat/Unplayed.tsx`])])]
  const [entry] = createSelector(four, memoryFiles(tree)).explain([`${UI}stores/turns.ts`])
  assert.deepEqual({ reason: entry.reason, features: entry.features }, { reason: "imported", features: ["chat.a", "chat.b"] })
})

test("app code no scenario reaches is reported as uncovered, tests and docs as not app code", () => {
  const selector = createSelector(zones(), memoryFiles(repo()))
  assert.deepEqual(pick(selector, [`${UI}lib/unplayed.ts`, `${UI}chat/Unplayed.tsx`, "packages/web/server/lib/new.js", `${UI}chat/Footer.test.tsx`, `${UI}chat/DOCUMENTATION.md`, "package.json"]), {
    [`${UI}lib/unplayed.ts`]: { reason: "uncovered", features: [] },
    [`${UI}chat/Unplayed.tsx`]: { reason: "uncovered", features: [] },
    "packages/web/server/lib/new.js": { reason: "uncovered", features: [] },
    [`${UI}chat/Footer.test.tsx`]: { reason: "not-app", features: [] },
    [`${UI}chat/DOCUMENTATION.md`]: { reason: "not-app", features: [] },
    "package.json": { reason: "not-app", features: [] },
  })
})

test("a test inside a listed directory does not make its imports part of the feature", () => {
  const tree = { ...repo(), [`${UI}chat/dir/View.tsx`]: "", [`${UI}chat/dir/View.test.tsx`]: 'import { x } from "@/lib/unplayed"' }
  const selector = createSelector([zone("chat", [`${UI}chat/dir/`], [feature("view")])], memoryFiles(tree))
  assert.equal(selector.explain([`${UI}lib/unplayed.ts`])[0].reason, "uncovered")
  assert.deepEqual(selector.explain([`${UI}chat/dir/View.tsx`])[0].features, ["chat.view"])
})

test("the runner and the fixtures it loads select every scenario", () => {
  const selector = createSelector(zones(), memoryFiles(repo()))
  const all = ["chat.history", "chat.footer", "chat.work-status", "composer.send", "composer.draft"]
  assert.deepEqual(pick(selector, ["scripts/verify/run.mjs", "scripts/perf/fixture.mjs", "scripts/perf/unrelated.mjs"]), {
    "scripts/verify/run.mjs": { reason: "net", features: all },
    "scripts/perf/fixture.mjs": { reason: "net", features: all },
    "scripts/perf/unrelated.mjs": { reason: "not-app", features: [] },
  })
})

test("a map change selects the features whose scenarios changed and those using a changed selector", () => {
  const vocabulary = { "chat.footer": { selector: "[data-footer]" }, "composer.send": { selector: "[data-send]" } }
  const before = { vocabulary, zones: zones() }
  const after = {
    vocabulary: { ...vocabulary, "composer.send": { selector: "[data-send-button]" }, "chat.new": { selector: "[data-new]" } },
    zones: [
      zone("chat", [], [feature("history"), feature("footer", undefined, [{ do: "see", on: "chat.footer" }]), feature("work-status"), feature("new")]),
      zone("composer", [], [feature("send", undefined, [{ do: "click", on: "composer.send" }]), feature("draft", undefined, [{ do: "drag", on: "chat.footer", to: { on: "chat.new" } }])]),
    ],
  }
  const mapChanges = diffMap(before, after)
  assert.deepEqual([...mapChanges.features], ["chat.footer", "chat.new", "composer.send", "composer.draft"])
  assert.deepEqual([...mapChanges.names], ["composer.send", "chat.new"])
  const selector = createSelector(after.zones, memoryFiles(repo()))
  assert.deepEqual(pick(selector, ["scripts/verify/zones/chat.json", "scripts/verify/vocabulary.json"], mapChanges), {
    "scripts/verify/zones/chat.json": { reason: "scenarios", features: ["chat.footer", "chat.new"] },
    "scripts/verify/vocabulary.json": { reason: "vocabulary", features: ["composer.send", "composer.draft"] },
  })
})

test("a feature whose texts or sources changed but not its scenarios runs nothing", () => {
  const before = { vocabulary: {}, zones: zones() }
  const after = { vocabulary: {}, zones: zones().map((z) => ({ ...z, sources: [], features: z.features.map((f) => ({ ...f, what: "reworded", sources: [] })) })) }
  assert.deepEqual(diffMap(before, after), { features: new Set(), names: new Set() })
})

test("a deleted file under a listed directory still selects its feature", () => {
  const selector = createSelector([zone("chat", [`${UI}chat/`], [feature("all")])], memoryFiles(repo()))
  assert.deepEqual(selector.explain([`${UI}chat/Gone.tsx`])[0], { file: `${UI}chat/Gone.tsx`, reason: "listed", features: ["chat.all"] })
})

test("a deleted file the code still imports selects the features that import it", () => {
  const tree = repo()
  delete tree[`${UI}lib/status.ts`]
  const deleted = [`${UI}lib/status.ts`]
  const selector = createSelector(zones(), keepingChangedFiles(memoryFiles(tree), deleted))
  assert.deepEqual(pick(selector, deleted), { [`${UI}lib/status.ts`]: { reason: "imported", features: ["chat.work-status"] } })
})
