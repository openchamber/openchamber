import { readFileSync } from "node:fs"
import process from "node:process"

import { reapStaleStands } from "./processes.mjs"

// The parent holds stdin open for the entire stand lifetime. No polling
// process, provider request or server is needed to notice its death.
process.stdin.resume()
process.stdin.once("end", () => {
  let owner
  try { owner = JSON.parse(readFileSync(process.argv[2], "utf8")) } catch { return }
  void reapStaleStands({ checkout: owner.checkout, only: process.argv[2], log: () => {} })
    .catch(() => { process.exitCode = 1 })
})
