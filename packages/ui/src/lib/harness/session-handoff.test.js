import { beforeEach, describe, expect, mock, test } from 'bun:test';

const getSyncMessagesMock = mock(() => []);

mock.module('@/sync/sync-refs', () => ({
  getSyncMessages: (...args) => getSyncMessagesMock(...args),
  getSyncParts: () => [],
}));

const { useSelectionStore } = await import('@/sync/selection-store');
const {
  applySessionExecutionTargetSelection,
  createEngineHandoffSession,
  shouldPersistHandoffWarnDismissal,
  shouldShowHandoffBillingNotice,
} = await import(`./session-handoff?cache-test=${Date.now()}`);

beforeEach(() => {
  getSyncMessagesMock.mockReset();
  getSyncMessagesMock.mockImplementation(() => []);
  useSelectionStore.setState({
    sessionTargets: new Map(),
    pendingHandoffTargets: new Map(),
    lastUsedTarget: null,
  });
});

describe('shouldShowHandoffBillingNotice', () => {
  test('shows for OpenCode → Claude when warn setting is true/undefined', () => {
    expect(shouldShowHandoffBillingNotice({
      sourceHarnessId: 'opencode',
      targetHarnessId: 'claude-code',
      warnOnOpenCodeHandoff: true,
    })).toBe(true);
    expect(shouldShowHandoffBillingNotice({
      sourceHarnessId: 'opencode',
      targetHarnessId: 'claude-code',
      warnOnOpenCodeHandoff: undefined,
    })).toBe(true);
  });

  test('hides when warn setting is false', () => {
    expect(shouldShowHandoffBillingNotice({
      sourceHarnessId: 'opencode',
      targetHarnessId: 'claude-code',
      warnOnOpenCodeHandoff: false,
    })).toBe(false);
  });

  test('hides for reverse or same-engine handoffs', () => {
    expect(shouldShowHandoffBillingNotice({
      sourceHarnessId: 'claude-code',
      targetHarnessId: 'opencode',
      warnOnOpenCodeHandoff: true,
    })).toBe(false);
    expect(shouldShowHandoffBillingNotice({
      sourceHarnessId: 'opencode',
      targetHarnessId: 'opencode',
      warnOnOpenCodeHandoff: true,
    })).toBe(false);
  });
});

describe('shouldPersistHandoffWarnDismissal', () => {
  test('persists only on Continue with checkbox', () => {
    expect(shouldPersistHandoffWarnDismissal({ confirmed: true, dontShowAgain: true })).toBe(true);
    expect(shouldPersistHandoffWarnDismissal({ confirmed: true, dontShowAgain: false })).toBe(false);
    expect(shouldPersistHandoffWarnDismissal({ confirmed: false, dontShowAgain: true })).toBe(false);
    expect(shouldPersistHandoffWarnDismissal({ confirmed: false, dontShowAgain: false })).toBe(false);
  });
});

describe('applySessionExecutionTargetSelection', () => {
  test('empty session updates sticky target in place', () => {
    getSyncMessagesMock.mockImplementation(() => []);
    const result = applySessionExecutionTargetSelection('ses_empty', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });
    expect(result).toBe('persisted');
    expect(useSelectionStore.getState().getSessionTarget('ses_empty')).toEqual({
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });
    expect(useSelectionStore.getState().getPendingHandoffTarget('ses_empty')).toBeNull();
  });

  test('used session marks pending handoff without rewriting sticky target', () => {
    getSyncMessagesMock.mockImplementation(() => [{ id: 'msg_1', role: 'user' }]);
    useSelectionStore.getState().saveSessionTarget('ses_used', {
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    });

    const result = applySessionExecutionTargetSelection('ses_used', {
      harnessId: 'claude-code',
      modelRef: 'opus',
    });
    expect(result).toBe('pending-handoff');
    expect(useSelectionStore.getState().getSessionTarget('ses_used')).toEqual({
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    });
    expect(useSelectionStore.getState().getPendingHandoffTarget('ses_used')).toEqual({
      harnessId: 'claude-code',
      modelRef: 'opus',
    });
  });
});

describe('createEngineHandoffSession', () => {
  test('creates a new session id via createSession mock', async () => {
    const createSession = mock(async () => ({ id: 'ses_new', directory: '/repo' }));
    const result = await createEngineHandoffSession({
      sourceSessionId: 'ses_source',
      directory: '/repo',
      createSession,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(undefined, '/repo');
    expect(result.sessionId).toBe('ses_new');
    expect(result.directory).toBe('/repo');
    expect(result.sessionId).not.toBe('ses_source');
  });

  test('passes source title through to createSession', async () => {
    const createSession = mock(async () => ({ id: 'ses_named', directory: '/repo' }));
    await createEngineHandoffSession({
      sourceSessionId: 'ses_source',
      directory: '/repo',
      title: 'Fix auth flow',
      sourceHarnessId: 'claude-code',
      createSession,
    });
    expect(createSession).toHaveBeenCalledWith('Fix auth flow', '/repo');
  });
});
