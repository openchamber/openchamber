import { describe, expect, test } from "bun:test"

import { pickDirectoriesToEvict } from "./eviction"
import { DIR_IDLE_TTL_MS, EVICTION_GRACE_MS, MAX_DIR_STORES } from "./types"

/**
 * Regression coverage for the sidebar cache-thrash loop (issue #1472).
 *
 * Expanding a project with many worktrees mounts a sidebar row per directory.
 * Each row calls `ensureChild` during render, while the pin that protects it is
 * only taken in an effect after commit. With more live directories than the
 * store limit, overflow eviction therefore disposed directories that were
 * actively being rendered; the next render recreated them with a `loading`
 * status, which issued another bootstrap request, and the cycle repeated
 * indefinitely.
 *
 * The fix treats the limit as a soft target: a directory touched within the
 * grace window is never an overflow victim, so a burst of live directories
 * overflows the cache briefly instead of thrashing. Idle directories stay
 * evictable, which is what keeps the cache bounded.
 */

const buildState = (directories: string[], lastAccessAt: number) =>
  new Map(directories.map((directory) => [directory, { lastAccessAt }]))

const directories = (count: number, prefix = "/repo/worktree-") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`)

describe("directory eviction under sidebar expansion", () => {
  test("does not evict directories that are being accessed right now", () => {
    const now = 1_000_000
    const stores = directories(MAX_DIR_STORES + 25)

    const evicted = pickDirectoriesToEvict({
      stores,
      state: buildState(stores, now),
      pins: new Set(),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      graceMs: EVICTION_GRACE_MS,
      now,
    })

    expect(evicted).toEqual([])
  })

  test("still evicts overflow once directories fall outside the grace window", () => {
    const now = 1_000_000
    const live = directories(MAX_DIR_STORES, "/repo/live-")
    const stale = directories(5, "/repo/stale-")
    const state = new Map([
      ...buildState(live, now),
      ...buildState(stale, now - EVICTION_GRACE_MS - 1),
    ])

    const evicted = pickDirectoriesToEvict({
      stores: [...live, ...stale],
      state,
      pins: new Set(),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      graceMs: EVICTION_GRACE_MS,
      now,
    })

    expect([...evicted].sort()).toEqual([...stale].sort())
  })

  test("still evicts directories idle past the TTL even inside the limit", () => {
    const now = 1_000_000
    const active = directories(3, "/repo/active-")
    const abandoned = directories(2, "/repo/abandoned-")
    const state = new Map([
      ...buildState(active, now),
      ...buildState(abandoned, now - DIR_IDLE_TTL_MS - 1),
    ])

    const evicted = pickDirectoriesToEvict({
      stores: [...active, ...abandoned],
      state,
      pins: new Set(),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      graceMs: EVICTION_GRACE_MS,
      now,
    })

    expect([...evicted].sort()).toEqual([...abandoned].sort())
  })

  test("never evicts pinned or blocked directories regardless of overflow", () => {
    const now = 1_000_000
    const stores = directories(MAX_DIR_STORES + 10)
    const stale = now - EVICTION_GRACE_MS - 1

    const evicted = pickDirectoriesToEvict({
      stores,
      state: buildState(stores, stale),
      pins: new Set([stores[0]]),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      graceMs: EVICTION_GRACE_MS,
      now,
      hasPendingBlockingRequests: (directory) => directory === stores[1],
    })

    expect(evicted).not.toContain(stores[0])
    expect(evicted).not.toContain(stores[1])
  })
})
