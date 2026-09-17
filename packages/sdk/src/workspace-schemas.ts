import { z } from 'zod';
import { GUEST_STORAGE_KEY_MAX, GUEST_STORAGE_VALUE_BYTES, GUEST_STORAGE_KEYS_MAX } from './workspace.ts';

const identity = z.string().trim().min(1).max(1024);
const state = z.enum(['loading', 'ready', 'error']);
const worktree = z.object({
  directory: identity, name: z.string(), branch: z.string(),
  status: z.enum(['ready', 'pending', 'invalid', 'missing']),
});
export const guestWorkspaceQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projects') }).strict(),
  z.object({ kind: z.literal('worktrees'), projectId: identity }).strict(),
  z.object({ kind: z.literal('sessions'), projectId: identity }).strict(),
]);
export const guestWorkspaceSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projects'), state, projects: z.array(z.object({ id: identity, name: z.string(), directory: identity })) }),
  z.object({ kind: z.literal('worktrees'), projectId: identity, state, worktrees: z.array(worktree) }),
  z.object({ kind: z.literal('sessions'), projectId: identity, state,
    coverage: z.array(z.object({ directory: identity, state })),
    sessions: z.array(z.object({
      id: identity, title: z.string(), projectId: identity, directory: identity, parentId: identity.nullable(),
      createdAt: z.number(), updatedAt: z.number(), archivedAt: z.number().nullable(), worktree: worktree.nullable(),
      activity: z.enum(['unknown', 'idle', 'running', 'retrying', 'waiting-permission', 'waiting-question']),
      outcome: z.enum(['completed', 'failed']).nullable(), items: z.array(z.object({ id: identity, data: z.json().optional() })),
    })),
  }),
]);
export const guestSessionWorktreeSchema = z.union([
  z.boolean(),
  z.object({ kind: z.literal('existing'), directory: identity }).strict(),
  z.object({ kind: z.literal('new'), name: z.string().trim().min(1).max(200).optional(), baseBranch: z.string().trim().min(1).max(200).optional() }).strict(),
]);
const storageKey = z.string().min(1).max(GUEST_STORAGE_KEY_MAX);
export const guestStorageRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), key: storageKey }).strict(),
  z.object({ op: z.literal('delete'), key: storageKey }).strict(),
  z.object({ op: z.literal('set'), key: storageKey, value: z.json().refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= GUEST_STORAGE_VALUE_BYTES) }).strict(),
  z.object({ op: z.literal('keys') }).strict(),
]);
export const guestStorageResultSchema = z.union([
  z.object({ storage: z.literal(true), op: z.literal('get'), found: z.literal(false) }),
  z.object({ storage: z.literal(true), op: z.literal('get'), found: z.literal(true), value: z.json() }),
  z.object({ storage: z.literal(true), op: z.enum(['set', 'delete']) }),
  z.object({ storage: z.literal(true), op: z.literal('keys'), keys: z.array(storageKey).max(GUEST_STORAGE_KEYS_MAX) }),
]);
