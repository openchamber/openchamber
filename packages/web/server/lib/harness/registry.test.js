import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_CODE_MODELS,
  getHarnessCapabilities,
  getHarnessDescriptor,
  HARNESS_IDS,
  isKnownHarnessId,
  listHarnessDescriptors,
} from './registry.js';

describe('harness registry', () => {
  it('lists opencode and claude-code', () => {
    expect([...HARNESS_IDS]).toEqual(['opencode', 'claude-code']);
    const ids = listHarnessDescriptors().map((d) => d.id);
    expect(ids).toEqual(['opencode', 'claude-code']);
  });

  it('exposes Claude Code subscription auth and capability matrix', () => {
    const claude = getHarnessDescriptor('claude-code');
    expect(claude.displayName).toBe('Claude Code');
    expect(claude.auth.mode).toBe('subscription-cli');
    expect(claude.install.binaryNames).toContain('claude');
    expect(claude.capabilities.prompt).toBe('full');
    expect(claude.capabilities.permissions).toBe('full');
    expect(claude.capabilities['file-attachments']).toBe('full');
    expect(claude.capabilities['slash-commands']).toBe('full');
    expect(claude.capabilities.mcp).toBe('full');
    expect(claude.capabilities.subagents).toBe('full');
    expect(claude.capabilities.multirun).toBe('full');
    expect(claude.capabilities.goal).toBe('full');
    expect(claude.capabilities['openchamber-tool']).toBe('full');
    expect(CLAUDE_CODE_MODELS.length).toBeGreaterThan(0);
    const byId = Object.fromEntries(CLAUDE_CODE_MODELS.map((model) => [model.id, model]));
    const displayNames = CLAUDE_CODE_MODELS.map((model) => model.name);
    expect(byId.fable?.name).toBe('Fable 5');
    expect(byId.opus?.name).toBe('Opus 5');
    expect(byId.sonnet?.name).toBe('Sonnet 5');
    expect(byId.haiku?.name).toBe('Haiku 4.5');
    expect(byId.haiku?.resolvedId).toBe('claude-haiku-4-5');
    expect(byId['claude-opus-4-8']?.name).toBe('Opus 4.8');
    expect(byId['claude-sonnet-4-6']?.name).toBe('Sonnet 4.6');
    expect(byId['claude-haiku-4-5']).toBeUndefined();
    expect(new Set(displayNames).size).toBe(displayNames.length);
    expect(byId.fable?.limit?.context).toBe(1_000_000);
    expect(byId.sonnet?.limit?.context).toBe(1_000_000);
    expect(byId.haiku?.limit?.context).toBe(200_000);
    for (const model of CLAUDE_CODE_MODELS) {
      expect(model.limit?.context).toBeGreaterThan(0);
      expect(model.reasoning).toBe(true);
      expect(model.toolCall).toBe(true);
    }
  });

  it('exposes OpenCode provider auth mode', () => {
    const opencode = getHarnessDescriptor('opencode');
    expect(opencode.auth.mode).toBe('opencode-providers');
    expect(getHarnessCapabilities('opencode').multirun).toBe('full');
  });

  it('rejects unknown harness ids', () => {
    expect(isKnownHarnessId('codex-cli')).toBe(false);
    expect(getHarnessDescriptor('nope')).toBeNull();
    expect(getHarnessCapabilities('nope')).toBeNull();
  });
});
