import { describe, expect, test } from 'bun:test';

import { resolveClaudeAgentsSendOptions } from './claude-agents-mode';

describe('resolveClaudeAgentsSendOptions', () => {
  test('opencode mode sets permissionMode and optional system prompt append', () => {
    const resolved = resolveClaudeAgentsSendOptions({
      target: { harnessId: 'claude-code', modelRef: 'sonnet', effort: 'high', permissionMode: 'plan' },
      agentsMode: 'opencode',
      agentName: undefined,
    });

    expect(resolved.agentsMode).toBe('opencode');
    expect(resolved.target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'sonnet',
      effort: 'high',
      // No agent → edit permission defaults to ask → Claude default
      permissionMode: 'default',
    });
    expect(resolved.systemPromptAppend).toBe(undefined);
  });

  test('claude mode strips inherited permissionMode and omits system prompt append', () => {
    const resolved = resolveClaudeAgentsSendOptions({
      target: {
        harnessId: 'claude-code',
        modelRef: 'opus',
        permissionMode: 'acceptEdits',
        effort: 'max',
      },
      agentsMode: 'claude',
      agentName: 'build',
    });

    expect(resolved).toEqual({
      agentsMode: 'claude',
      target: {
        harnessId: 'claude-code',
        modelRef: 'opus',
        effort: 'max',
      },
    });
  });
});
