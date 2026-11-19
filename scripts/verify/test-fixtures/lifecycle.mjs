// A private map in the test subprocess exercises the real runner's exit paths.
// The checkout's scenarios and timeouts are never edited by this fixture.
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

import { Page } from "../browser.mjs"

const mode = process.env.VERIFY_LIFECYCLE_MODE
const read = fs.readFileSync
fs.readFileSync = (file, ...args) => {
  const content = read(file, ...args)
  if (!String(file).replaceAll("\\", "/").endsWith("/zones/workspace.json")) return content
  const zone = JSON.parse(String(content))
  const steps = mode === "failure"
    ? [{ do: "file.expect", path: "not-created-by-lifecycle", exists: true, timeout: 0.01 }]
    : mode === "SIGINT" || mode === "SIGTERM"
      ? [{ do: "pause", ms: 60_000 }]
      : [{ do: "file.write", path: "lifecycle-check.txt", content: "saved" }, { do: "file.expect", path: "lifecycle-check.txt", equals: "saved" }]
  zone.features = [{ ...zone.features[0], id: "lifecycle", scenarios: [{ id: "case", title: "Runner lifecycle", kind: "path", steps }] }]
  return JSON.stringify(zone)
}
syncBuiltinESMExports()
if (mode === "throw") Page.open = async () => { throw new Error("Deliberate lifecycle startup error") }
