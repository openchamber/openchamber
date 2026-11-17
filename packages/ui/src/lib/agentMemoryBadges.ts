
import type { AgentMemoryEntry, AgentMemoryScope } from './agentMemoryApi';

export type MemoryBadge = 'new' | 'changed' | null;

export const memoryViewKey = (scope: AgentMemoryScope, projectPath: string | null): string => (
  scope === 'global' ? 'global' : `project:${projectPath ?? ''}`
);

export const classifyMemory = (entry: AgentMemoryEntry, viewedAt: number): MemoryBadge => {
  if (entry.createdAt > viewedAt) {
    return 'new';
  }
  if (entry.updatedAt > viewedAt) {
    return 'changed';
  }
  return null;
};

export const countHighlightedMemories = (entries: AgentMemoryEntry[], viewedAt: number): number => (
  entries.reduce((total, entry) => (classifyMemory(entry, viewedAt) ? total + 1 : total), 0)
);
