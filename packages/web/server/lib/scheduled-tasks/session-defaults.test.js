import { describe, expect, it } from 'vitest';

import { createChatsScope, CHATS_SCOPE_PUBLIC_ID } from './chats-scope.js';
import { createReadSessionDefaults, resolveSessionDefaults } from './session-defaults.js';

describe('createReadSessionDefaults', () => {
  const chatsScope = createChatsScope('/home/me/.openchamber/chats');
  const settings = {
    defaultModel: 'anthropic/claude-sonnet-5', defaultVariant: 'high', defaultAgent: 'build',
    chatsDefaultModel: 'openai/gpt-6', chatsDefaultVariant: 'low', chatsDefaultAgent: 'plan',
    projects: [{ id: 'proj', defaultModel: 'google/gemini-4', defaultAgent: 'review' }],
  };
  const readFor = (current) => createReadSessionDefaults({
    readSettings: async () => current,
    sanitizeProjects: (projects) => projects,
    chatsScopeID: chatsScope.id,
  });

  it('reads the Chats defaults for the Chats storage id, which is what scheduled runs pass', async () => {
    expect(await readFor(settings)(chatsScope.id))
      .toEqual({ providerID: 'openai', modelID: 'gpt-6', variant: 'low', agent: 'plan' });
    expect(chatsScope.toStorageID(CHATS_SCOPE_PUBLIC_ID)).toBe(chatsScope.id);
  });

  it('falls back to the global defaults for an empty Chats field, and reads a project by its id', async () => {
    const empty = { ...settings, chatsDefaultModel: '', chatsDefaultVariant: '', chatsDefaultAgent: '' };
    expect(await readFor(empty)(chatsScope.id))
      .toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high', agent: 'build' });
    expect(await readFor(settings)('proj'))
      .toEqual({ providerID: 'google', modelID: 'gemini-4', variant: null, agent: 'review' });
    expect(await readFor(settings)('unknown'))
      .toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high', agent: 'build' });
  });

  it('keeps Auto as the Chats model when the OpenCode catalog does not list it', async () => {
    const auto = { ...settings, chatsDefaultModel: 'openchamber/auto', chatsDefaultVariant: '' };
    const catalog = [{ providerID: 'anthropic', id: 'claude-sonnet-5', variants: [{ id: 'high' }] }];
    expect(await readFor(auto)(chatsScope.id, catalog))
      .toEqual({ providerID: 'openchamber', modelID: 'auto', variant: null, agent: 'plan' });
  });
});

describe('resolveSessionDefaults', () => {
  it('prefers the project default, then the global one, keeping each variant with its model', () => {
    const settings = { defaultModel: 'anthropic/claude-sonnet-5', defaultVariant: 'high', defaultAgent: 'build' };
    expect(resolveSessionDefaults({ settings, project: { defaultModel: 'openai/gpt-6', defaultAgent: 'plan' } }))
      .toEqual({ providerID: 'openai', modelID: 'gpt-6', variant: null, agent: 'plan' });
    expect(resolveSessionDefaults({ settings, project: {} }))
      .toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high', agent: 'build' });
  });

  it('inherits the global thinking level only when the project names the same model', () => {
    const settings = { defaultModel: 'openai/gpt-6', defaultVariant: 'high' };
    expect(resolveSessionDefaults({ settings, project: { defaultModel: 'openai/gpt-6' } }).variant).toBe('high');
    expect(resolveSessionDefaults({ settings, project: { defaultModel: 'openai/gpt-6', defaultVariant: 'low' } }).variant).toBe('low');
    expect(resolveSessionDefaults({ settings, project: { defaultModel: 'openai/gpt-7' } }).variant).toBeNull();
  });

  it('skips a model the catalog confirms is gone, and keeps it when the catalog is unknown', () => {
    const settings = { defaultModel: 'anthropic/claude-sonnet-5', defaultVariant: 'high', defaultAgent: 'build' };
    const project = { defaultModel: 'openai/gone', defaultVariant: 'low', defaultAgent: 'plan' };
    const catalog = [{ providerID: 'anthropic', id: 'claude-sonnet-5', variants: [{ id: 'high' }] }];
    expect(resolveSessionDefaults({ settings, project, catalog }))
      .toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high', agent: 'plan' });
    expect(resolveSessionDefaults({ settings, project, catalog: null }).modelID).toBe('gone');
    expect(resolveSessionDefaults({ settings, project, catalog: [] }).modelID).toBe('gone');
    const onlyZen = [{ providerID: 'opencode', id: 'big-pickle' }];
    expect(resolveSessionDefaults({ settings: { defaultModel: 'opencode/big-pickle' }, project, catalog: onlyZen }).modelID).toBe('gone');
    expect(resolveSessionDefaults({ settings: {}, project, catalog }).modelID).toBe('gone');
    expect(resolveSessionDefaults({ settings: { defaultModel: 'openai/also-gone' }, project: null, catalog }).modelID).toBe('also-gone');
    const disabled = [...catalog, { providerID: 'openai', id: 'gone', enabled: false }];
    expect(resolveSessionDefaults({ settings, project, catalog: disabled }).modelID).toBe('claude-sonnet-5');
  });

  it('drops a thinking level the catalog model does not offer', () => {
    const settings = { defaultModel: 'anthropic/claude-sonnet-5', defaultVariant: 'max' };
    const catalog = [{ providerID: 'anthropic', id: 'claude-sonnet-5', variants: [{ id: 'high' }] }];
    expect(resolveSessionDefaults({ settings, project: null, catalog }).variant).toBeNull();
  });

  it('leaves everything to OpenCode when nothing is set', () => {
    expect(resolveSessionDefaults({ settings: {}, project: null }))
      .toEqual({ providerID: null, modelID: null, variant: null, agent: null });
    expect(resolveSessionDefaults({ settings: { defaultModel: 'no-slash' }, project: null }).modelID).toBeNull();
  });
});
