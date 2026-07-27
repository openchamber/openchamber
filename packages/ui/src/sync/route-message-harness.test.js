import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const harnessPromptCalls = [];
const harnessPromptMock = mock(async (params) => {
  harnessPromptCalls.push(params);
  return { ok: true, status: 'started' };
});

class HarnessClientError extends Error {
  constructor(message, code, statusCode = 500, status) {
    super(message);
    this.name = 'HarnessClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = status;
  }
}

mock.module('@/lib/harness/client', () => ({
  HarnessClientError,
  harnessPrompt: harnessPromptMock,
  harnessAbort: mock(async () => ({ ok: true })),
  harnessPermissionReply: mock(async () => ({ ok: true })),
  harnessSessionCapabilities: mock(async (sessionId) => ({
    sessionId,
    harnessId: 'claude-code',
    capabilities: {
      sessionId,
      slashCommands: ['compact', 'usage', 'clear'],
      skills: [],
      agents: [],
      tools: [],
      mcpServers: [],
      updatedAt: 0,
    },
  })),
  buildHarnessPromptBody: (params) => params,
}));

const { opencodeClient } = await import('@/lib/opencode/client');
const { routeMessage } = await import(`./session-ui-store?harness-route=${Date.now()}`);
const { setActionRefs, setOptimisticRefs } = await import('./session-actions');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSelectionStore } = await import('./selection-store');
const { useHarnessStore } = await import('@/stores/useHarnessStore');
const { useCommandsStore } = await import('@/stores/useCommandsStore');
const { useSkillsStore } = await import('@/stores/useSkillsStore');
const { setCachedClaudeAgentsMode } = await import('@/lib/harness/settings');

describe('routeMessage Claude harness branch', () => {
  const sendMessageCalls = [];
  const shellSessionCalls = [];
  let originalSendMessage;
  let originalShellSession;

  beforeEach(() => {
    harnessPromptCalls.length = 0;
    sendMessageCalls.length = 0;
    shellSessionCalls.length = 0;
    harnessPromptMock.mockClear();
    setCachedClaudeAgentsMode('opencode');

    const childStore = {
      getState: () => ({
        session: [],
        message: {},
        part: {},
        session_status: {},
      }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => '/claude/project');
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true });
    useCommandsStore.setState({ commands: [] });
    useSkillsStore.setState({ skills: [] });
    useSelectionStore.setState({
      sessionTargets: new Map(),
      lastUsedTarget: null,
    });
    useHarnessStore.setState({
      catalogsById: {
        'claude-code': {
          engine: {
            id: 'claude-code',
            displayName: 'Claude Code',
            shortName: 'Claude',
            auth: { mode: 'subscription-cli' },
            capabilities: {},
            install: { binaryNames: ['claude'], docsUrl: 'https://example.com' },
          },
          status: 'ready',
          sections: [{ id: 'models', name: 'Models', kind: 'models', models: [{ id: 'sonnet', name: 'Sonnet' }] }],
        },
      },
      loadState: 'ready',
      error: null,
    });

    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendMessage = async (params) => {
      sendMessageCalls.push(params);
      return 'msg';
    };
    originalShellSession = opencodeClient.shellSession;
    opencodeClient.shellSession = async (params) => {
      shellSessionCalls.push(params);
      return { info: {}, parts: [] };
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
    opencodeClient.shellSession = originalShellSession;
    useSelectionStore.setState({
      sessionTargets: new Map(),
      lastUsedTarget: null,
    });
  });

  test('routes Claude targets through harnessPrompt and skips OpenCode sendMessage', async () => {
    useSelectionStore.getState().saveSessionTarget('session-claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });

    await routeMessage({
      sessionId: 'session-claude',
      directory: '/claude/project',
      content: 'hello claude',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      files: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,x', filename: 'a.png' }],
    });

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].sessionId).toBe('session-claude');
    expect(harnessPromptCalls[0].directory).toBe('/claude/project');
    expect(harnessPromptCalls[0].target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'sonnet',
      permissionMode: 'default',
    });
    expect(harnessPromptCalls[0].agentsMode).toBe('opencode');
    expect(harnessPromptCalls[0].text).toBe('hello claude');
    expect(harnessPromptCalls[0].files).toEqual([{ mime: 'image/png', url: 'data:image/png;base64,x', filename: 'a.png' }]);
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('claude agents mode omits OpenCode-derived permissionMode', async () => {
    setCachedClaudeAgentsMode('claude');
    useSelectionStore.getState().saveSessionTarget('session-claude-native', {
      harnessId: 'claude-code',
      modelRef: 'opus',
      permissionMode: 'acceptEdits',
    });

    await routeMessage({
      sessionId: 'session-claude-native',
      directory: '/claude/project',
      content: 'native agents',
      providerID: 'anthropic',
      modelID: 'claude-opus',
      agent: 'build',
    });

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].agentsMode).toBe('claude');
    expect(harnessPromptCalls[0].target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'opus',
    });
    expect(harnessPromptCalls[0].systemPromptAppend).toBeUndefined();
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('routes shell mode through OpenCode session.shell on Claude sessions', async () => {
    useSelectionStore.getState().saveSessionTarget('session-claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });

    await routeMessage({
      sessionId: 'session-claude',
      directory: '/claude/project',
      content: 'ls',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      agent: 'build',
      inputMode: 'shell',
    });

    expect(shellSessionCalls).toHaveLength(1);
    expect(shellSessionCalls[0]).toEqual({
      sessionId: 'session-claude',
      directory: '/claude/project',
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      command: 'ls',
    });
    expect(harnessPromptCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('keeps OpenCode path when session target is opencode', async () => {
    useSelectionStore.getState().saveSessionTarget('session-oc', {
      harnessId: 'opencode',
      providerId: 'provider-a',
      modelId: 'model-a',
    });

    await routeMessage({
      sessionId: 'session-oc',
      directory: '/claude/project',
      content: 'hello opencode',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(harnessPromptCalls).toHaveLength(0);
  });

  test('blocks Claude send when engine is not ready', async () => {
    useSelectionStore.getState().saveSessionTarget('session-claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });
    useHarnessStore.setState({
      catalogsById: {
        'claude-code': {
          engine: {
            id: 'claude-code',
            displayName: 'Claude Code',
            shortName: 'Claude',
            auth: { mode: 'subscription-cli' },
            capabilities: {},
            install: { binaryNames: ['claude'], docsUrl: 'https://example.com' },
          },
          status: 'needs-login',
          sections: [],
        },
      },
      loadState: 'ready',
      error: null,
    });

    let caught = null;
    try {
      await routeMessage({
        sessionId: 'session-claude',
        directory: '/claude/project',
        content: 'hello',
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught?.code).toBe('CLAUDE_NOT_READY');
    expect(harnessPromptCalls).toHaveLength(0);
  });

  test('routes Claude-native /compact through harnessPrompt', async () => {
    useSelectionStore.getState().saveSessionTarget('session-claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });

    await routeMessage({
      sessionId: 'session-claude',
      directory: '/claude/project',
      content: '/compact',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
    });

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].text).toBe('/compact');
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('rejects OpenCode-only slash commands on Claude sessions', async () => {
    useSelectionStore.getState().saveSessionTarget('session-claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });
    useCommandsStore.setState({
      commands: [{ name: 'opencode-only-cmd', description: 'oc', scope: 'global' }],
    });

    let caught = null;
    try {
      await routeMessage({
        sessionId: 'session-claude',
        directory: '/claude/project',
        content: '/opencode-only-cmd',
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught?.code).toBe('CLAUDE_SLASH_UNSUPPORTED');
    expect(harnessPromptCalls).toHaveLength(0);
  });
});
