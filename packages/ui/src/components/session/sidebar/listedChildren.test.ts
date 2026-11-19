import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from './types';
import { listedChildren } from './listedChildren';

// SAFETY: only the identity, parent, and metadata are read here.
const session = (id: string, fields: Partial<Session> = {}): Session => ({
  id,
  title: id,
  directory: '/repo',
  time: { created: 1, updated: 1 },
  ...fields,
} as Session);

const node = (id: string, children: SessionNode[] = []): SessionNode => ({ session: session(id), children, worktree: null });
const child = (session: Session): SessionNode => ({ session, children: [], worktree: null });

describe('listedChildren', () => {
  test('lists the sessions an agent spawned while subagent sessions are shown', () => {
    const subagent = child(session('sub', { parentID: 'parent' }));
    const parent = node('parent', [subagent]);

    expect(listedChildren(parent)).toEqual([subagent]);
    expect(listedChildren(parent, true)).toEqual([subagent]);
  });

  test('hides a spawned session when subagent sessions are hidden, keeping other children', () => {
    const subagent = child(session('sub', { parentID: 'parent' }));
    const review = child(session('review', {
      metadata: { openchamber: { kind: 'review', originalSessionID: 'parent' } },
    }));
    const parent = node('parent', [subagent, review]);

    expect(listedChildren(parent, false)).toEqual([review]);
  });

  test('keeps withholding a workflow agent session in both modes', () => {
    const workflowAgent = child(session('workflow', { metadata: { openchamber: { kind: 'workflow-agent' } } }));
    const parent = node('parent', [workflowAgent]);

    expect(listedChildren(parent)).toEqual([]);
    expect(listedChildren(parent, false)).toEqual([]);
  });

  test('returns the children unchanged when nothing is withheld', () => {
    const parent = node('parent', [child(session('child'))]);

    expect(listedChildren(parent)).toBe(parent.children);
    expect(listedChildren(parent, false)).toBe(parent.children);
  });
});
