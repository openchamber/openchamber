import { describe, expect, test } from 'bun:test';
import { buildAgentDuplicateDraft } from './useAgentsStore';
import type { Agent } from '@/lib/opencode/model';

// SAFETY: a resolved AgentInfo as OpenCode answers it; only the fields the
// draft helper reads (description, system, mode) vary by case.
const resolvedAgent = (overrides: Partial<Agent>): Agent => ({
  id: 'org-build',
  name: 'org-build',
  displayName: 'org-build',
  mode: 'subagent',
  description: 'Builds things',
  system: 'Be helpful.',
  request: { settings: {}, headers: {}, body: {} },
  hidden: false,
  permissions: [],
  ...overrides,
} as Agent);

describe('buildAgentDuplicateDraft', () => {
  test('copies a user-scoped stored entry as-is', () => {
    const draft = buildAgentDuplicateDraft(
      resolvedAgent({ description: 'Resolved', system: 'Resolved prompt.' }),
      {
        source: 'md',
        scope: 'user',
        path: '~/.config/opencode/agents/org-build.md',
        legacy: false,
        config: { description: 'Stored', model: 'anthropic/claude-sonnet-4-5', system: 'Stored prompt.' },
      },
      'org-build-copy',
    );
    expect(draft).toEqual({
      name: 'org-build-copy',
      scope: 'user',
      description: 'Stored',
      model: 'anthropic/claude-sonnet-4-5',
      system: 'Stored prompt.',
      steps: undefined,
      temperature: undefined,
      top_p: undefined,
      mode: 'subagent',
      permissions: undefined,
      hidden: undefined,
    });
  });

  test('coerces a system-scoped copy to the user scope', () => {
    const draft = buildAgentDuplicateDraft(
      resolvedAgent({}),
      { source: 'md', scope: 'system', path: '/etc/opencode/agents/org-build.md', legacy: false, config: { model: 'openai/gpt-5' } },
      'org-build-copy',
    );
    expect(draft.scope).toBe('user');
    expect(draft.model).toBe('openai/gpt-5');
  });

  test('falls back to the resolved description and prompt when the system entry is partial', () => {
    // An org pinning only a model over a built-in like explore stores nothing
    // else; the copy must not come out empty-handed.
    const draft = buildAgentDuplicateDraft(
      resolvedAgent({ description: 'Read-only explorer', system: 'Explore the code.' }),
      { source: 'json', scope: 'system', path: '/etc/opencode/opencode.json', legacy: false, config: { model: 'openai/gpt-5' } },
      'org-build-copy',
    );
    expect(draft.scope).toBe('user');
    expect(draft.description).toBe('Read-only explorer');
    expect(draft.system).toBe('Explore the code.');
    // The stored entry's permissions are the copy's permissions; resolved
    // defaults never widen them.
    expect(draft.permissions).toBeUndefined();
  });

  test('keeps a partial non-system entry partial, without baking resolved values in', () => {
    const draft = buildAgentDuplicateDraft(
      resolvedAgent({ description: 'Resolved', system: 'Resolved prompt.' }),
      { source: 'json', scope: 'user', path: '~/.config/opencode/opencode.json', legacy: false, config: { model: 'openai/gpt-5' } },
      'org-build-copy',
    );
    expect(draft.scope).toBe('user');
    expect(draft.description).toBeUndefined();
    expect(draft.system).toBeUndefined();
  });
});