import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { QUOTA_PROVIDERS } from "./providers/index"

// Conformance for the quota provider manifest (design #1808, phase 1 #1809):
// the UI catalog and the QuotaProviderId type union are surfaces of the one
// logical provider set the manifest states (the canonical file lives with
// the web quota module; this test reads it from the repo tree by relative
// path). A provider that appears in a list but not the manifest fails, and
// so does a manifest provider silently absent from a list - a surface
// absence is only ever a named exception in the manifest, never a silent
// one (contract rule 2). The union is a type, so its members are read from
// the types source; it is also the one surface where an alias (openai)
// currently sits, recorded as the manifest alias row's open note (rule 3).

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(here, "../../../../web/server/lib/quota/provider-manifest.json"),
    "utf8"
  )
)

const expectedFor = (surface: string) =>
  new Set<string>(
    [...manifest.providers, ...manifest.aliases]
      .filter((row: { surfaces: Record<string, boolean> }) => row.surfaces[surface])
      .map((row: { id: string }) => row.id)
  )

const unionIds = () => {
  const source = fs.readFileSync(path.join(here, "../../types/quota.ts"), "utf8")
  const match = source.match(/QuotaProviderId\s*=\s*([^;]+);/s)
  if (!match) throw new Error("QuotaProviderId union not found")
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

describe("quota provider manifest (ui)", () => {
  test("the QUOTA_PROVIDERS catalog is exactly the manifest ui_catalog surface", () => {
    expect(new Set(QUOTA_PROVIDERS.map((provider) => provider.id))).toEqual(
      expectedFor("ui_catalog")
    )
  })

  test("catalog display names match the manifest names", () => {
    const names = new Map(
      manifest.providers.map((row: { id: string; name: string }) => [row.id, row.name])
    )
    for (const provider of QUOTA_PROVIDERS) {
      expect(provider.name).toBe(names.get(provider.id))
    }
  })

  test("the QuotaProviderId union is exactly the manifest ui_union surface (providers plus recorded aliases)", () => {
    expect(unionIds()).toEqual(expectedFor("ui_union"))
  })
})
