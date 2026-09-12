import { describe, expect, test } from 'bun:test';

import type { AgentWithExtras } from '@/stores/useAgentsStore';
import { selectVisibleAgents } from './useVisibleAgentsForDirectory';

const makeAgent = (name: string, extras: Partial<AgentWithExtras> = {}): AgentWithExtras => ({
  name,
  mode: 'primary',
  permission: [],
  options: {},
  ...extras,
});

describe('selectVisibleAgents', () => {
  test('a loaded directory list wins over the ambient list', () => {
    const scoped = [makeAgent('orchestrator')];
    const ambient = [makeAgent('build'), makeAgent('plan')];

    expect(selectVisibleAgents(scoped, ambient).map((agent) => agent.name)).toEqual(['orchestrator']);
  });

  test('a loaded-but-empty directory list is authoritative, not a loading state', () => {
    expect(selectVisibleAgents([], [makeAgent('build')])).toEqual([]);
  });

  test('unloaded scope falls back to the ambient list without another project agents', () => {
    const ambient = [
      makeAgent('build', { scope: 'user' }),
      makeAgent('shared-plugin'),
      makeAgent('project-agent', { scope: 'project' }),
    ];

    expect(selectVisibleAgents(undefined, ambient).map((agent) => agent.name)).toEqual([
      'build',
      'shared-plugin',
    ]);
  });

  test('hidden agents stay hidden in both branches', () => {
    const scoped = [
      makeAgent('visible'),
      makeAgent('internal', { hidden: true }),
      makeAgent('option-hidden', { options: { hidden: true } }),
    ];

    expect(selectVisibleAgents(scoped, []).map((agent) => agent.name)).toEqual(['visible']);
    expect(
      selectVisibleAgents(undefined, [makeAgent('ambient-hidden', { hidden: true }), makeAgent('ambient')])
        .map((agent) => agent.name),
    ).toEqual(['ambient']);
  });
});
