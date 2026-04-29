/**
 * Provider Concurrency Tracker
 *
 * Tracks per-provider session activity to enable:
 * - Admission control (warn when hitting provider concurrency limits)
 * - Circuit breaking (pause requests to a provider during error storms)
 * - Health-check awareness (skip OpenCode restart when provider is busy)
 *
 * Inspired by HiveMind (arXiv:2604.17111) OS-inspired scheduling primitives.
 */

const DEFAULT_CIRCUIT_BREAK_THRESHOLD = 3
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000
const DEFAULT_RETRY_BASE_DELAY_MS = 1000
const DEFAULT_RETRY_MAX_DELAY_MS = 32_000
const DEFAULT_RETRY_MAX_ATTEMPTS = 3
const PROVIDER_EVICTION_TTL_MS = 60 * 60 * 1000
const PROVIDER_EVICTION_INTERVAL_MS = 10 * 60 * 1000

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504])

type ProviderState = {
  activeSessions: Set<string>
  consecutiveErrors: number
  lastErrorAt: number
  circuitOpen: boolean
  circuitOpenAt: number
  circuitCooldownMs: number
}

const providers = new Map<string, ProviderState>()

function evictStaleProviders(): void {
  const now = Date.now()
  for (const [providerID, state] of providers) {
    if (
      state.activeSessions.size === 0 &&
      state.consecutiveErrors === 0 &&
      now - state.lastErrorAt > PROVIDER_EVICTION_TTL_MS
    ) {
      providers.delete(providerID)
    }
  }
}

if (typeof setInterval !== 'undefined') {
  setInterval(evictStaleProviders, PROVIDER_EVICTION_INTERVAL_MS)
}

function getOrCreateProvider(providerID: string): ProviderState {
  let state = providers.get(providerID)
  if (!state) {
    state = {
      activeSessions: new Set(),
      consecutiveErrors: 0,
      lastErrorAt: 0,
      circuitOpen: false,
      circuitOpenAt: 0,
      circuitCooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
    }
    providers.set(providerID, state)
  }
  return state
}

export function trackSessionStarted(sessionID: string, providerID: string): void {
  if (!sessionID || !providerID) return
  const state = getOrCreateProvider(providerID)
  state.activeSessions.add(sessionID)
}

export function trackSessionEnded(sessionID: string, providerID: string): void {
  if (!sessionID || !providerID) return
  const state = providers.get(providerID)
  if (!state) return
  state.activeSessions.delete(sessionID)
}

export function getActiveSessionCountForProvider(providerID: string): number {
  const state = providers.get(providerID)
  return state?.activeSessions.size ?? 0
}

export function getTotalActiveSessionCount(): number {
  let count = 0
  for (const state of providers.values()) {
    count += state.activeSessions.size
  }
  return count
}

export function getProviderConcurrencySnapshot(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [providerID, state] of providers) {
    if (state.activeSessions.size > 0) {
      result[providerID] = state.activeSessions.size
    }
  }
  return result
}

export function recordProviderSuccess(providerID: string): void {
  if (!providerID) return
  const state = providers.get(providerID)
  if (!state) return
  state.consecutiveErrors = 0
  state.lastErrorAt = 0
}

export function recordProviderError(providerID: string, status?: number): void {
  if (!providerID) return
  const state = getOrCreateProvider(providerID)
  state.consecutiveErrors += 1
  state.lastErrorAt = Date.now()

  if (
    isCircuitBreakerStatus(status) &&
    state.consecutiveErrors >= DEFAULT_CIRCUIT_BREAK_THRESHOLD
  ) {
    state.circuitOpen = true
    state.circuitOpenAt = Date.now()
    console.warn(
      `[provider-tracker] Circuit opened for ${providerID} after ${state.consecutiveErrors} consecutive errors`
    )
  }
}

function isCircuitBreakerStatus(status?: number): boolean {
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status)
}

export function isCircuitOpen(providerID: string): boolean {
  const state = providers.get(providerID)
  if (!state?.circuitOpen) return false

  const elapsed = Date.now() - state.circuitOpenAt
  if (elapsed >= state.circuitCooldownMs) {
    state.circuitOpen = false
    state.consecutiveErrors = 0
    state.circuitCooldownMs = Math.min(
      state.circuitCooldownMs * 2,
      DEFAULT_RETRY_MAX_DELAY_MS * 4
    )
    return false
  }

  return true
}

export function shouldRetry(providerID: string, status: number, attempt: number): boolean {
  if (!RETRYABLE_STATUS_CODES.has(status)) return false
  if (attempt >= DEFAULT_RETRY_MAX_ATTEMPTS - 1) return false
  if (isCircuitOpen(providerID)) return false
  return true
}

export function getRetryDelayMs(attempt: number): number {
  const delay = DEFAULT_RETRY_BASE_DELAY_MS * 2 ** attempt
  return Math.min(delay, DEFAULT_RETRY_MAX_DELAY_MS)
}

export function resetCircuit(providerID: string): void {
  const state = providers.get(providerID)
  if (!state) return
  state.consecutiveErrors = 0
  state.circuitOpen = false
  state.circuitCooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS
}

export function cleanupSession(sessionID: string): void {
  for (const state of providers.values()) {
    state.activeSessions.delete(sessionID)
  }
}
