import { beforeEach, describe, expect, test } from 'bun:test';
import type { EngineCatalog, HarnessId } from '@/types/harness';
import { useSelectionStore } from '@/sync/selection-store';
import { useHarnessStore } from '@/stores/useHarnessStore';
import {
  engineSupportsSteerDelivery,
  getHarnessCapabilityLevel,
  resolveSessionHarnessId,
  sessionSupports,
  sessionSupportsSteerDelivery,
  STATIC_HARNESS_CAPABILITIES,
} from './capabilities';

beforeEach(() => {
  useSelectionStore.setState({
    sessionTargets: new Map(),
    pendingHandoffTargets: new Map(),
    lastUsedTarget: null,
  });
  useHarnessStore.setState({
    catalogs: [],
    catalogsById: {},
    loadState: 'idle',
    error: null,
    selectedHarnessId: 'opencode',
    isDetecting: {},
    scopeKey: null,
  });
});

describe('sessionSupports', () => {
  test('defaults to OpenCode capabilities when no target is known', () => {
    expect(resolveSessionHarnessId(null)).toBe('opencode');
    expect(sessionSupports(null, 'goal')).toBe(true);
    expect(sessionSupports(null, 'multirun')).toBe(true);
  });

  test('supports goal, multirun, and openchamber-tool on Claude', () => {
    useSelectionStore.getState().saveSessionTarget('ses_claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });
    expect(sessionSupports('ses_claude', 'goal')).toBe(true);
    expect(sessionSupports('ses_claude', 'multirun')).toBe(true);
    expect(sessionSupports('ses_claude', 'openchamber-tool')).toBe(true);
    expect(sessionSupports('ses_claude', 'prompt')).toBe(true);
    expect(sessionSupports('ses_claude', 'abort')).toBe(true);
  });

  test('prefers sticky session target over last-used', () => {
    useSelectionStore.setState({
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'opus' },
    });
    useSelectionStore.getState().saveSessionTarget('ses_oc', {
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'sonnet',
    });
    expect(sessionSupports('ses_oc', 'goal')).toBe(true);
  });

  test('uses pending handoff when sticky target is absent', () => {
    useSelectionStore.getState().setPendingHandoffTarget('ses_new', {
      harnessId: 'claude-code',
      modelRef: 'haiku',
    });
    expect(sessionSupports('ses_new', 'goal')).toBe(true);
    expect(sessionSupports('ses_new', 'multirun')).toBe(true);
  });

  test('falls back to last-used target for drafts', () => {
    useSelectionStore.setState({
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    expect(sessionSupports(null, 'goal')).toBe(true);
    expect(sessionSupports(null, 'multirun')).toBe(true);
  });

  test('Claude sessions do not support steer delivery', () => {
    expect(engineSupportsSteerDelivery('opencode')).toBe(true);
    expect(engineSupportsSteerDelivery('claude-code')).toBe(false);
    useSelectionStore.getState().saveSessionTarget('ses_claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });
    expect(sessionSupportsSteerDelivery('ses_claude')).toBe(false);
    useSelectionStore.setState({ lastUsedTarget: null });
    expect(sessionSupportsSteerDelivery('ses_unknown')).toBe(true);
  });

  test('prefers catalog capability levels when present', () => {
    const catalog: EngineCatalog = {
      engine: {
        id: 'claude-code',
        displayName: 'Claude Code',
        shortName: 'Claude',
        auth: { mode: 'subscription-cli' },
        capabilities: {
          ...STATIC_HARNESS_CAPABILITIES['claude-code'],
          prompt: 'none',
        },
        install: { binaryNames: ['claude'], docsUrl: 'https://example.com' },
      },
      status: 'ready',
      sections: [],
    };
    useHarnessStore.setState({
      catalogs: [catalog],
      catalogsById: { 'claude-code': catalog } as Partial<Record<HarnessId, EngineCatalog>>,
      loadState: 'ready',
      error: null,
    });
    expect(getHarnessCapabilityLevel('claude-code', 'prompt')).toBe('none');
    expect(getHarnessCapabilityLevel('claude-code', 'goal')).toBe('full');
  });
});
