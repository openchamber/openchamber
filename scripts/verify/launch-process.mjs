import { spawn } from "node:child_process"
import process from "node:process"

import { prioritizeWindowsProcess } from "./windows-priority.mjs"

// This leader stays alive until tree cleanup, even if Bun's script wrapper
// exits first. Its identity keeps the process group from being recycled.
// argv[2] names the isolated root for recovery before registration completes.
process.on("SIGINT", () => {})
process.on("SIGTERM", () => {})
process.on("disconnect", () => { setInterval(() => {}, 60_000) })
prioritizeWindowsProcess()
const child = spawn(process.argv[3], process.argv.slice(4), { stdio: ["ignore", "inherit", "inherit"], windowsHide: true })
const report = (message) => { if (process.connected) process.send(message, () => {}) }
child.once("error", (error) => report({ type: "target.exit", code: 1, error: error.message }))
child.once("exit", (code, signal) => report({ type: "target.exit", code: code ?? 1, signal }))
if (child.pid) prioritizeWindowsProcess(child.pid)
