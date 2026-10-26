import { describe, expect, test } from 'bun:test';

import type { AgentMemoryEntry } from '@/lib/agentMemoryApi';
import { formatMemoryForTidy } from './memoryTidy';

const entry = (id: string, title: string, body: string, extra: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry => ({
  id,
  title,
  body,
  type: 'fact',
  createdAt: Date.UTC(2026, 8, 1),
  updatedAt: Date.UTC(2026, 9, 2),
  ...extra,
});

describe('formatMemoryForTidy', () => {
  test('hands the agent every entry in full, with the id and scope a rewrite needs', () => {
    const text = formatMemoryForTidy({
      global: [entry('g1', 'Replies in Ukrainian', 'The user wants replies in Ukrainian.', { type: 'preference' })],
      project: [entry('p1', 'Tests run with bun', 'Run the server suites with bun test.')],
    });

    expect(text).toContain('#### Replies in Ukrainian\nmemoryId: g1 | scope: global | type: preference | created 2026-09-01 | updated 2026-10-02\n\nThe user wants replies in Ukrainian.');
    expect(text).toContain('#### Tests run with bun\nmemoryId: p1 | scope: project | type: fact');
    expect(text.indexOf('scope: global')).toBeLessThan(text.indexOf('scope: project'));
  });

  test('marks flagged entries so the agent leaves them to the user', () => {
    const text = formatMemoryForTidy({ global: [], project: [entry('p1', 'T', 'b', { flagged: true })] });
    expect(text).toContain('| flagged');
  });

  test('an empty scope says so instead of disappearing', () => {
    const text = formatMemoryForTidy({ global: [], project: [entry('p1', 'T', 'b')] });
    expect(text).toContain('### About the user (scope: global)\n\nNo entries.');
  });
});
