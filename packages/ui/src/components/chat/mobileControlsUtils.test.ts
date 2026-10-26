import { describe, expect, test } from 'bun:test';
import type { Agent } from '@/lib/opencode/model';
import { getCycledPrimaryAgentName } from './mobileControlsUtils';

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
