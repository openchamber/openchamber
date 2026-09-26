import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { useProjectWorktrees } from './useProjectWorktrees';

const project = { id: 'repo', path: '/repo' };
const removed: WorktreeMetadata = { source: 'sdk', name: 'removed', label: 'removed', path: '/repo-removed', projectDirectory: '/repo', branch: 'removed' };
const retained: WorktreeMetadata = { source: 'sdk', name: 'retained', label: 'retained', path: '/repo-retained', projectDirectory: '/repo', branch: 'retained' };

describe('Manage worktrees listing', () => {
  let dom: Window;
  let root: Root;
  let host: HTMLDivElement;
  let serverWorktrees: WorktreeMetadata[];
  let failListing: boolean;
  let sessionsKey: string;
  let listing: { availableWorktrees: WorktreeMetadata[]; isLoadingWorktrees: boolean };

  const listWorktrees = async () => {
    if (failListing) throw new Error('List failed');
    return serverWorktrees;
  };
  const Probe = () => {
    listing = useProjectWorktrees(project, true, sessionsKey, listWorktrees);
    return <div>{listing.availableWorktrees.map((item) => <span key={item.path}>{item.branch}</span>)}</div>;
  };

  beforeEach(async () => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    serverWorktrees = [removed, retained];
    failListing = false;
    sessionsKey = 'before';
    useSessionUIStore.setState({ availableWorktrees: [removed, retained], availableWorktreesByProject: new Map([[project.id, [removed, retained]]]) });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    dom.close();
  });

  test('removes the deleted row after server confirmation, even when session change refreshed before removal', async () => {
    expect(host.textContent).toBe('removedretained');
    expect(listing.availableWorktrees).toHaveLength(2);

    // Archiving linked sessions triggers the existing sessionsKey refresh before git removes the worktree.
    sessionsKey = 'after-archive';
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe('removedretained');

    serverWorktrees = [retained];
    await act(async () => {
      useSessionUIStore.setState({ availableWorktrees: [retained], availableWorktreesByProject: new Map([[project.id, [retained]]]) });
    });
    expect(host.textContent).toBe('retained');
    expect(listing.availableWorktrees).toHaveLength(1);
  });

  test('keeps a confirmed deletion visible when a follow-up listing fails', async () => {
    expect(listing.availableWorktrees).toHaveLength(2);
    failListing = true;
    await act(async () => {
      useSessionUIStore.setState({ availableWorktrees: [retained], availableWorktreesByProject: new Map([[project.id, [retained]]]) });
    });
    expect(host.textContent).toBe('retained');
  });

  test('keeps the previous list when a session-triggered refresh fails without a deletion', async () => {
    failListing = true;
    sessionsKey = 'after-archive';
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe('removedretained');
  });
});
