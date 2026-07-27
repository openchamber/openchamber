import { describe, expect, test } from 'bun:test';
import { parseEngineCatalog } from './catalog';

describe('parseEngineCatalog model fields', () => {
  test('preserves Claude model limits, modalities, and capability flags', () => {
    const catalog = parseEngineCatalog({
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
        install: {
          binaryNames: ['claude'],
          docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
        },
      },
      status: 'ready',
      sections: [{
        id: 'models',
        name: 'Models',
        kind: 'models',
        models: [{
          id: 'sonnet',
          name: 'Sonnet 5',
          supportsImages: true,
          supportsDocuments: true,
          reasoning: true,
          toolCall: true,
          limit: { context: 1_000_000, output: 128_000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        }],
      }],
    });

    expect(catalog).not.toBeNull();
    expect(catalog?.sections[0]?.models[0]).toEqual({
      id: 'sonnet',
      name: 'Sonnet 5',
      supportsImages: true,
      supportsDocuments: true,
      reasoning: true,
      toolCall: true,
      limit: { context: 1_000_000, output: 128_000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
    });
  });
});
