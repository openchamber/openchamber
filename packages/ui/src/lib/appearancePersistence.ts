import { useUIStore } from '@/stores/useUIStore';
import type { ReasoningMode } from '@/lib/api/types';

export interface AppearancePreferences {
  reasoningMode?: ReasoningMode;
}

type RawAppearancePayload = {
  reasoningMode?: unknown;
  // Legacy booleans, accepted for backward-compat migration.
  showReasoningTraces?: unknown;
  collapsibleThinkingBlocks?: unknown;
};

const REASONING_MODE_VALUES = new Set<ReasoningMode>(['off', 'collapsible-hidden', 'collapsible-dynamic', 'full']);

/**
 * Resolve a `reasoningMode` enum from the stored payload, accepting either the
 * new enum or the legacy boolean pair (`showReasoningTraces` /
 * `collapsibleThinkingBlocks`). Returns `undefined` when no usable signal is
 * present.
 */
const resolveReasoningMode = (payload: RawAppearancePayload): ReasoningMode | undefined => {
  if (typeof payload.reasoningMode === 'string' && REASONING_MODE_VALUES.has(payload.reasoningMode as ReasoningMode)) {
    return payload.reasoningMode as ReasoningMode;
  }

  const hasTraces = typeof payload.showReasoningTraces === 'boolean';
  const hasCollapsible = typeof payload.collapsibleThinkingBlocks === 'boolean';
  if (!hasTraces && !hasCollapsible) {
    return undefined;
  }

  // Legacy migration: derive the enum from the previous booleans.
  const traces = hasTraces ? (payload.showReasoningTraces as boolean) : true;
  if (!traces) {
    return 'off';
  }
  const collapsible = hasCollapsible ? (payload.collapsibleThinkingBlocks as boolean) : true;
  return collapsible ? 'collapsible-dynamic' : 'full';
};

const sanitizePreferences = (payload?: RawAppearancePayload | null): AppearancePreferences | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const reasoningMode = resolveReasoningMode(payload);
  const result: AppearancePreferences = {};

  if (reasoningMode) {
    result.reasoningMode = reasoningMode;
  }

  return Object.keys(result).length > 0 ? result : null;
};

const extractRawAppearance = (data: unknown): RawAppearancePayload | null => {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidate = data as Record<string, unknown>;
  const payload: RawAppearancePayload = {
    reasoningMode: candidate.reasoningMode,
    showReasoningTraces: candidate.showReasoningTraces,
    collapsibleThinkingBlocks: candidate.collapsibleThinkingBlocks,
  };

  return payload;
};

export const applyAppearancePreferences = (preferences: AppearancePreferences): void => {
  const store = useUIStore.getState();

  if (preferences.reasoningMode) {
    store.setReasoningMode(preferences.reasoningMode);
  }
};

export const loadAppearancePreferences = async (): Promise<AppearancePreferences | null> => {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = localStorage.getItem('appearance-preferences');
  if (!stored) {
    return null;
  }

  try {
    const data = JSON.parse(stored) as unknown;
    const payload = extractRawAppearance(data);
    return sanitizePreferences(payload);
  } catch (error) {
    console.warn('Failed to parse stored appearance preferences:', error);
    return null;
  }
};