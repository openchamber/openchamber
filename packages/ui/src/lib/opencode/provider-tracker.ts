/**
 * Provider Circuit-Breaker & Retry Tracker
 *
 * Tracks per-provider error state to enable:
 * - Transparent retry with exponential backoff for transient errors
 * - Circuit breaking (pause requests to a provider during error storms)
 *
 * Inspired by HiveMind (arXiv:2604.17111) OS-inspired scheduling primitives.
 */

import { getRuntimeKey } from '@/lib/runtime-switch'

const DEFAULT_CIRCUIT_BREAK_THRESHOLD = 3
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000
const DEFAULT_RETRY_BASE_DELAY_MS = 1000
const DEFAULT_RETRY_MAX_DELAY_MS = 32_000
const DEFAULT_RETRY_MAX_ATTEMPTS = 3
const PROVIDER_EVICTION_TTL_MS = 60 * 60 * 1000
const PROVIDER_EVICTION_INTERVAL_MS = 10 * 60 * 1000
const PROVIDER_MAX_ENTRIES = 200

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504])

type ProviderState = {
  consecutiveErrors: number
  lastErrorAt: number
  circuitOpen: boolean
  circuitOpenAt: number
  circuitCooldownMs: number
}

const providers = new Map<string, ProviderState>()
const providerKey = (providerID: string): string => JSON.stringify([getRuntimeKey(), providerID])

function evictStaleProviders(): void {
  const now = Date.now()
  for (const [key, state] of providers) {
    const lastActivityAt = Math.max(state.lastErrorAt, state.circuitOpenAt)
    if (now - lastActivityAt > PROVIDER_EVICTION_TTL_MS) {
      providers.delete(key)
    }
  }
}

if (typeof setInterval !== 'undefined') {
  const interval = setInterval(evictStaleProviders, PROVIDER_EVICTION_INTERVAL_MS)
  ;(interval as unknown as { unref?: () => void }).unref?.()
}

function getOrCreateProvider(providerID: string): ProviderState {
  const key = providerKey(providerID)
  let state = providers.get(key)
  if (!state) {
    state = {
      consecutiveErrors: 0,
      lastErrorAt: 0,
      circuitOpen: false,
      circuitOpenAt: 0,
      circuitCooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
    }
    providers.set(key, state)
    while (providers.size > PROVIDER_MAX_ENTRIES) {
      const oldest = providers.keys().next().value
      if (!oldest) break
      providers.delete(oldest)
    }
  }
  return state
}

export function recordProviderSuccess(providerID: string): void {
  if (!providerID) return
  providers.delete(providerKey(providerID))
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

function isCircuitOpen(providerID: string): boolean {
  const state = providers.get(providerKey(providerID))
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

export function assertProviderCircuitClosed(providerID: string): void {
  if (!providerID || !isCircuitOpen(providerID)) return
  throw new Error(`Provider ${providerID} is temporarily unavailable after repeated errors. Please retry shortly.`)
}

export function getRetryDelayMs(attempt: number): number {
  const delay = DEFAULT_RETRY_BASE_DELAY_MS * 2 ** attempt
  return Math.min(delay, DEFAULT_RETRY_MAX_DELAY_MS)
}
