import { z } from 'zod';

const memoryRecordSchema = z.record(z.string(), z.unknown());
type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export type MemoryScope = 'global' | 'project';

export interface MemoryTarget {
  scope: MemoryScope;
  projectId?: string;
}

export type MemoryType = 'fact' | 'preference' | 'reference';

export interface MemoryEntry {
  id: string;
  title: string;
  body: string;
  type: MemoryType;
  createdAt: number;
  updatedAt: number;
  flagged?: boolean;
  sessionId?: string;
}

export interface MemoryWriteInput {
  title?: unknown;
  body?: unknown;
  type?: unknown;
  sessionId?: unknown;
}

export interface MemoryChangedEvent {
  scope: MemoryScope;
  projectId?: string;
}

export interface MemoryDocument {
  version: number;
  entries: MemoryEntry[];
}

export const isMemoryText = (value: unknown): value is string => typeof value === 'string';

export const isMemoryType = (value: unknown): value is MemoryType => (
  value === 'fact' || value === 'preference' || value === 'reference'
);

export const isMemoryRecord = (value: unknown): value is MemoryRecord => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

export const isMemoryTimestamp = (value: unknown): value is number => (
  Number.isFinite(value)
);
