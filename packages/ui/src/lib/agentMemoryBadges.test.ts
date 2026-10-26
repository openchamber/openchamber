import { describe, expect, test } from 'bun:test';

import { classifyMemory, countHighlightedMemories, memoryViewKey } from './agentMemoryBadges';
import type { AgentMemoryEntry } from './agentMemoryApi';

const entry = (overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry => ({
  id: 'mem-1',
  title: 'Uses bun',
  body: 'Tests run with bun test.',
  type: 'fact',
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

describe('classifying an entry against the last look', () => {
  test('an entry stored since the last look is new', () => {
    expect(classifyMemory(entry({ createdAt: 200, updatedAt: 200 }), 100)).toBe('new');
  });

  test('an entry rewritten since the last look is changed, not new', () => {
    // The distinction matters: a memory the agent invented and one it quietly
    // rewrote need different attention.
    expect(classifyMemory(entry({ createdAt: 50, updatedAt: 200 }), 100)).toBe('changed');
  });

  test('an untouched entry carries no badge', () => {
    expect(classifyMemory(entry({ createdAt: 50, updatedAt: 50 }), 100)).toBeNull();
  });

  test('a rewrite the user already saw carries no badge', () => {
    expect(classifyMemory(entry({ createdAt: 10, updatedAt: 50 }), 100)).toBeNull();
  });

  test('everything is new before the user has ever looked', () => {
    expect(classifyMemory(entry({ createdAt: 1, updatedAt: 1 }), 0)).toBe('new');
  });

  test('an entry stored exactly at the last look is not re-announced', () => {
    expect(classifyMemory(entry({ createdAt: 100, updatedAt: 100 }), 100)).toBeNull();
  });
});

describe('counting what deserves a glance', () => {
  test('counts new and changed together', () => {
    const count = countHighlightedMemories([
      entry({ id: 'a', createdAt: 200, updatedAt: 200 }),
      entry({ id: 'b', createdAt: 50, updatedAt: 200 }),
      entry({ id: 'c', createdAt: 50, updatedAt: 50 }),
    ], 100);

    expect(count).toBe(2);
  });

  test('an untouched store counts nothing', () => {
    expect(countHighlightedMemories([entry({ createdAt: 1, updatedAt: 1 })], 100)).toBe(0);
  });
});

describe('where each scope keeps its mark', () => {
  test('global has one mark', () => {
    expect(memoryViewKey('global', '/tmp/anything')).toBe('global');
  });

  test('each project keeps its own', () => {
    // One shared project mark would let opening one project silently clear
    // another project's badges.
    expect(memoryViewKey('project', '/tmp/a')).not.toBe(memoryViewKey('project', '/tmp/b'));
  });

  test('a project scope with no path never collides with global', () => {
    expect(memoryViewKey('project', null)).not.toBe('global');
  });
});
