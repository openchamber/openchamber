import { mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export const DEFAULT_SLOTS = 2
const SLOTS_DIR = join(tmpdir(), "openchamber-verify-slots")
const RETRY_MS = 5000
const REMINDER_EVERY = 60
const GUARD_STALE_MS = 30_000

const processIsAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === "EPERM" }
}

export const slotLimit = (value) => {
  const limit = Number.parseInt(value ?? "", 10)
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_SLOTS
}

const holderOf = (file) => {
  try { return Number.parseInt(readFileSync(file, "utf8"), 10) } catch { return Number.NaN }
}

/**
 * One process at a time looks at the slots and changes them: a folder made
 * with mkdir is the guard, and one left by a process that died mid-way is
 * removed once it is older than any honest holder keeps it.
 */
const withGuard = (dir, action) => {
  const guard = join(dir, "guard")
  try {
    mkdirSync(guard)
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    try { if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmdirSync(guard) } catch { return null }
    return null
  }
  try { return action() } finally { rmdirSync(guard) }
}

/**
 * Takes one of the machine's stand slots. Answers the slot file, or the
 * process ids holding every slot when none is free, or null when another
 * process was looking at the slots at that moment.
 */
export const takeSlot = ({ dir, slots, pid, isAlive }) => {
  mkdirSync(dir, { recursive: true })
  return withGuard(dir, () => {
    const holders = []
    for (let index = 1; index <= slots; index += 1) {
      const file = join(dir, `slot-${index}`)
      const holder = holderOf(file)
      if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) { holders.push(holder); continue }
      writeFileSync(file, String(pid))
      return { file }
    }
    return { holders }
  })
}

export const releaseSlot = ({ file, pid }) => {
  if (holderOf(file) === pid) rmSync(file, { force: true })
}

/**
 * Waits for a stand slot and returns the function that gives it back. A stand
 * with its browser is the heaviest thing a session starts, and a machine runs
 * only a few at once before every run slows down; the rest wait their turn.
 */
export const acquireSlot = async ({ log, dir = SLOTS_DIR, slots = slotLimit(process.env.OPENCHAMBER_VERIFY_SLOTS), pid = process.pid, isAlive = processIsAlive, wait = () => delay(RETRY_MS) }) => {
  for (let attempt = 0; ; attempt += 1) {
    const taken = takeSlot({ dir, slots, pid, isAlive })
    if (taken?.file) {
      const release = () => releaseSlot({ file: taken.file, pid })
      process.once("exit", release)
      return () => { process.off("exit", release); release() }
    }
    if (taken && attempt % REMINDER_EVERY === 0) {
      log(`${slots} stands are already running on this machine (processes ${taken.holders.join(", ")}); waiting for one to finish`)
    }
    await wait()
  }
}
