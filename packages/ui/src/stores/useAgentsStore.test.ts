import { describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

import { filterVisibleAgents } from './useAgentsStore';

describe('filterVisibleAgents', () => {
  test('keeps only non-hidden direct-selection agents', () => {
    const agents = [
      { name: 'build', mode: 'primary', permission: [] },
      { name: 'plan', mode: 'all', permission: [] },
      { name: 'code-reviewer', mode: 'subagent', permission: [] },
      { name: 'title', mode: 'primary', permission: [], hidden: true },
      { name: 'summary', mode: 'all', permission: [], options: { hidden: true } },
    ] as Agent[];

    expect(filterVisibleAgents(agents).map((agent) => agent.name)).toEqual(['build', 'plan']);
  });
});
