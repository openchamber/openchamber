import { describe, expect, test } from 'bun:test';
import { resolveComposerAttachmentModel } from './composer-attachment-model';
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
      supportsImages: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    }],
  }],
};

describe('resolveComposerAttachmentModel', () => {
  test('uses Claude catalog modalities when session target is Claude', () => {
    const resolved = resolveComposerAttachmentModel({
      sessionId: 'ses_claude',
      sessionTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
      openCodeProviderId: 'opencode',
      openCodeModelId: 'big-pickle',
      openCodeMetadata: {
        id: 'big-pickle',
        providerId: 'opencode',
        name: 'Big Pickle',
        modalities: { input: ['text'], output: ['text'] },
      },
      claudeCatalog,
    });

    expect(resolved.modelKey).toBe('claude-code/sonnet');
    expect(resolved.modelName).toBe('Sonnet');
    expect(resolved.inputModalities).toEqual(['text', 'image']);
  });

  test('falls back to OpenCode metadata when engine is OpenCode', () => {
    const resolved = resolveComposerAttachmentModel({
      sessionId: 'ses_oc',
      sessionTarget: {
        harnessId: 'opencode',
        providerId: 'opencode',
        modelId: 'big-pickle',
      },
      openCodeProviderId: 'opencode',
      openCodeModelId: 'big-pickle',
      openCodeMetadata: {
        id: 'big-pickle',
        providerId: 'opencode',
        name: 'Big Pickle',
        modalities: { input: ['text'], output: ['text'] },
      },
      claudeCatalog,
    });

    expect(resolved.modelKey).toBe('opencode/big-pickle');
    expect(resolved.modelName).toBe('Big Pickle');
    expect(resolved.inputModalities).toEqual(['text']);
  });

  test('uses last-used Claude target for drafts without a session', () => {
    const resolved = resolveComposerAttachmentModel({
      sessionId: null,
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'opus' },
      openCodeProviderId: 'opencode',
      openCodeModelId: 'big-pickle',
      openCodeMetadata: {
        id: 'big-pickle',
        providerId: 'opencode',
        name: 'Big Pickle',
        modalities: { input: ['text'], output: ['text'] },
      },
      claudeCatalog: null,
    });

    expect(resolved.modelKey).toBe('claude-code/opus');
    expect(resolved.inputModalities).toContain('image');
  });
});
