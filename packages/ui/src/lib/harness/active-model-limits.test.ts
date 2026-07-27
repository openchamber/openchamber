import { describe, expect, test } from 'bun:test';
import { resolveActiveModelLimits } from './active-model-limits';
import type { EngineCatalog } from '@/types/harness';

const claudeCatalog: EngineCatalog = {
  engine: {
    id: 'claude-code',
    displayName: 'Claude Code',
    shortName: 'Claude',
    auth: { mode: 'subscription-cli' },
    capabilities: {
      prompt: 'full',
      abort: 'full',
      resume: 'full',
      'streaming-text': 'full',
      'streaming-tools': 'full',
      permissions: 'full',
      images: 'full',
      'file-attachments': 'full',
      shell: 'full',
      'slash-commands': 'partial',
      mcp: 'partial',
      subagents: 'partial',
      multirun: 'full',
      goal: 'full',
      'openchamber-tool': 'full',
    },
    install: { binaryNames: ['claude'], docsUrl: 'https://example.com' },
  },
  status: 'ready',
  sections: [{
    id: 'models',
    name: 'Models',
    kind: 'models',
    models: [{
      id: 'sonnet',
      name: 'Sonnet',
      limit: { context: 200_000, output: 64_000 },
    }],
  }],
};

describe('resolveActiveModelLimits', () => {
  test('uses Claude catalog limits when session target is Claude', () => {
    expect(resolveActiveModelLimits({
      sessionId: 'ses_claude',
      sessionTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
      claudeCatalog,
      openCodeContext: 128_000,
      openCodeOutput: 8_000,
      openCodeModelName: 'Big Pickle',
    })).toEqual({
      context: 200_000,
      output: 64_000,
      modelName: 'Sonnet',
      source: 'claude-code',
    });
  });

  test('keeps OpenCode limits when engine is OpenCode', () => {
    expect(resolveActiveModelLimits({
      sessionId: 'ses_oc',
      sessionTarget: {
        harnessId: 'opencode',
        providerId: 'opencode',
        modelId: 'big-pickle',
      },
      claudeCatalog,
      openCodeContext: 128_000,
      openCodeOutput: 8_000,
      openCodeModelName: 'Big Pickle',
    })).toEqual({
      context: 128_000,
      output: 8_000,
      modelName: 'Big Pickle',
      source: 'opencode',
    });
  });

  test('uses last-used Claude target for drafts without a session', () => {
    expect(resolveActiveModelLimits({
      sessionId: null,
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
      claudeCatalog,
      openCodeContext: 128_000,
      openCodeOutput: 8_000,
      openCodeModelName: 'Big Pickle',
    })).toEqual({
      context: 200_000,
      output: 64_000,
      modelName: 'Sonnet',
      source: 'claude-code',
    });
  });
});
