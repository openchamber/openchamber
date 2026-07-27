/**
 * Session / harness capability helpers.
 * Prefer catalog descriptors when loaded; fall back to static registry constants.
 */

import type { CapabilityLevel, HarnessCapability, HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';
import { useSelectionStore } from '@/sync/selection-store';
import { useHarnessStore } from '@/stores/useHarnessStore';

/** Mirrors packages/web/server/lib/harness/registry.js capability matrices. */
export const STATIC_HARNESS_CAPABILITIES: Record<HarnessId, Record<HarnessCapability, CapabilityLevel>> = {
  opencode: {
    prompt: 'full',
    abort: 'full',
    resume: 'full',
    'streaming-text': 'full',
    'streaming-tools': 'full',
    permissions: 'full',
    images: 'full',
    'file-attachments': 'full',
    shell: 'full',
    'slash-commands': 'full',
    mcp: 'full',
    subagents: 'full',
    multirun: 'full',
    goal: 'full',
    'openchamber-tool': 'full',
  },
  'claude-code': {
    prompt: 'full',
    abort: 'full',
    resume: 'full',
    'streaming-text': 'full',
    'streaming-tools': 'full',
    permissions: 'full',
    images: 'full',
    'file-attachments': 'full',
    shell: 'full',
    'slash-commands': 'full',
    mcp: 'full',
    subagents: 'full',
    multirun: 'full',
    goal: 'full',
    'openchamber-tool': 'full',
  },
};

export function resolveSessionHarnessId(sessionId?: string | null): HarnessId {
  const selection = useSelectionStore.getState();
  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (trimmed) {
    const sticky = selection.getSessionTarget(trimmed) ?? selection.getPendingHandoffTarget(trimmed);
    if (sticky && isHarnessId(sticky.harnessId)) {
      return sticky.harnessId;
    }
  }
  const lastUsed = selection.getLastUsedTarget();
  if (lastUsed && isHarnessId(lastUsed.harnessId)) {
    return lastUsed.harnessId;
  }
  return 'opencode';
}

export function getHarnessCapabilityLevel(
  harnessId: HarnessId,
  capability: HarnessCapability,
): CapabilityLevel {
  const catalog = useHarnessStore.getState().getCatalog(harnessId);
  const fromCatalog = catalog?.engine.capabilities?.[capability];
  if (fromCatalog === 'full' || fromCatalog === 'partial' || fromCatalog === 'none') {
    return fromCatalog;
  }
  return STATIC_HARNESS_CAPABILITIES[harnessId]?.[capability] ?? 'none';
}

/**
 * Whether a session (or draft via last-used/pending target) supports a capability.
 * `none` ⇒ unsupported; `partial` and `full` ⇒ supported for UI gating.
 */
export function sessionSupports(
  sessionId: string | null | undefined,
  capability: HarnessCapability,
): boolean {
  const harnessId = resolveSessionHarnessId(sessionId);
  return getHarnessCapabilityLevel(harnessId, capability) !== 'none';
}

/**
 * OpenCode can inject follow-ups into an active turn (`delivery: 'steer'`).
 * Claude Code rejects concurrent prompts with TURN_IN_PROGRESS — follow-ups
 * must use the OpenChamber message queue and wait for idle auto-send.
 */
export function engineSupportsSteerDelivery(harnessId: HarnessId): boolean {
  return harnessId === 'opencode';
}

export function sessionSupportsSteerDelivery(sessionId: string | null | undefined): boolean {
  return engineSupportsSteerDelivery(resolveSessionHarnessId(sessionId));
}
