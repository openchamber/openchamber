import { describe, expect, test } from 'bun:test';
import type { Agent } from '@/lib/opencode/model';
import { getCycledPrimaryAgentName, getEffortTone } from './mobileControlsUtils';

const agent = (name: string, mode: Agent['mode'] = 'primary'): Pick<Agent, 'name' | 'mode'> => ({ name, mode });
const agents = [agent('build'), agent('plan'), agent('incident'), agent('review'), agent('helper', 'subagent')];

describe('getCycledPrimaryAgentName', () => {
  test('without favorites cycles through every primary agent as before', () => {
    expect(getCycledPrimaryAgentName(agents, 'build')).toBe('plan');
    expect(getCycledPrimaryAgentName(agents, 'review')).toBe('build');
    expect(getCycledPrimaryAgentName(agents, 'build', -1)).toBe('review');
  });

  test('with favorites cycles through the favorites only', () => {
    const favorites = ['build', 'review'];
    expect(getCycledPrimaryAgentName(agents, 'build', 1, favorites)).toBe('review');
    expect(getCycledPrimaryAgentName(agents, 'review', 1, favorites)).toBe('build');
    expect(getCycledPrimaryAgentName(agents, 'review', -1, favorites)).toBe('build');
  });

  test('enters the favorites from an agent outside them', () => {
    expect(getCycledPrimaryAgentName(agents, 'incident', 1, ['plan', 'review'])).toBe('plan');
    expect(getCycledPrimaryAgentName(agents, 'incident', -1, ['plan', 'review'])).toBe('review');
  });

  test('a single favorite is a fixed point, and unavailable favorites are ignored', () => {
    expect(getCycledPrimaryAgentName(agents, 'plan', 1, ['plan'])).toBeNull();
    expect(getCycledPrimaryAgentName(agents, 'build', 1, ['plan'])).toBe('plan');
    expect(getCycledPrimaryAgentName(agents, 'build', 1, ['gone', 'helper'])).toBe('plan');
  });
});

describe('getEffortTone', () => {
  test('only the default level, or no level, stays grey', () => {
    expect(getEffortTone(undefined)).toBe('default');
    expect(getEffortTone('default')).toBe('default');
    expect(getEffortTone('Default')).toBe('default');
  });

  test('tints each OpenCode level by how hard it thinks', () => {
    for (const level of ['none', 'minimal', 'low', 'thinking']) expect(getEffortTone(level)).toBe('info');
    for (const level of ['medium', 'High']) expect(getEffortTone(level)).toBe('warning');
    for (const level of ['xhigh', 'max']) expect(getEffortTone(level)).toBe('error');
  });

  test('an unknown level reads as info', () => {
    expect(getEffortTone('turbo')).toBe('info');
    expect(getEffortTone('8000')).toBe('info');
  });
});
