import { afterEach, describe, expect, test } from 'bun:test';

import type { Metadata, ToolInput, ToolPart } from '@/lib/opencode/model';
import { toolListingChanges } from '@/lib/opencode/tools';
import {
  affectedDirectories,
  fileTreeChanges,
  subscribeFileTreeChanges,
  type FileTreeChange,
} from './fileTreeChanges';

const unsubscribers: Array<() => void> = [];
afterEach(() => {
  while (unsubscribers.length > 0) unsubscribers.pop()?.();
});

const record = (): FileTreeChange[] => {
  const changes: FileTreeChange[] = [];
  unsubscribers.push(subscribeFileTreeChanges((change) => changes.push(change)));
  return changes;
};

let sessionCounter = 0;
const nextSession = () => `ses_${++sessionCounter}`;

const toolPart = (
  sessionID: string,
  tool: string,
  status: 'running' | 'completed' | 'error',
  input: ToolInput = {},
  metadata?: Metadata,
): ToolPart => {
  const base = { id: 'prt_1', sessionID, messageID: 'msg_1', type: 'tool' as const, callID: 'call_1', tool };
  if (status === 'running') return { ...base, state: { status, input, time: { start: 1 } } };
  if (status === 'error') return { ...base, state: { status, input, error: 'boom', metadata, time: { start: 1, end: 2 } } };
  return { ...base, state: { status, input, output: '', metadata, time: { start: 1, end: 2 } } };
};

describe('toolListingChanges', () => {
  test('write names its file, edit and read change no listing', () => {
    expect(toolListingChanges('write', { path: 'src/new.ts' }, undefined)).toEqual(['src/new.ts']);
    expect(toolListingChanges('edit', { path: 'src/a.ts' }, undefined)).toEqual([]);
    expect(toolListingChanges('read', { path: 'src/a.ts' }, undefined)).toEqual([]);
  });

  test('patch counts the files in its text and the ones it reported, once each', () => {
    const patchText = '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: lib/new.ts\n*** Delete File: gone.ts\n*** End Patch';
    expect(toolListingChanges('patch', { patchText }, { files: [{ file: 'lib/new.ts' }, { file: 'gone.ts' }] }))
      .toEqual(['src/old.ts', 'gone.ts', 'lib/new.ts']);
  });

  test('shell, execute and unknown tools could touch anything', () => {
    expect(toolListingChanges('shell', { command: 'ls' }, undefined)).toBeNull();
    expect(toolListingChanges('execute', { code: '' }, undefined)).toBeNull();
    expect(toolListingChanges('my_mcp.write_file', {}, undefined)).toBeNull();
  });
});

describe('fileTreeChanges', () => {
  test('a finished write reports its file resolved against the session directory', () => {
    const changes = record();
    const session = nextSession();
    const running = toolPart(session, 'write', 'running', { path: 'src/new.ts' });
    fileTreeChanges.toolTransition('/repo', running, toolPart(session, 'write', 'completed', { path: 'src/new.ts' }));
    fileTreeChanges.toolTransition('/repo', undefined, toolPart(session, 'write', 'completed', { path: '/elsewhere/x.ts' }));
    expect(changes).toEqual([
      { directory: '/repo', paths: ['/repo/src/new.ts'] },
      { directory: '/repo', paths: ['/elsewhere/x.ts'] },
    ]);
  });

  test('a tool reported final twice, or still running, reports nothing', () => {
    const changes = record();
    const session = nextSession();
    const done = toolPart(session, 'write', 'completed', { path: 'a.ts' });
    fileTreeChanges.toolTransition('/repo', done, done);
    fileTreeChanges.toolTransition('/repo', undefined, toolPart(session, 'write', 'running', { path: 'a.ts' }));
    expect(changes).toEqual([]);
  });

  test('a shell call waits for its step: no change when the snapshot saw none', () => {
    const changes = record();
    const session = nextSession();
    fileTreeChanges.toolTransition('/repo', undefined, toolPart(session, 'shell', 'completed', { command: 'git status' }));
    expect(changes).toEqual([]);
    fileTreeChanges.stepCompleted('/repo', session, []);
    expect(changes).toEqual([]);
  });

  test('a shell call whose step changed files, or ended without a snapshot, reports an unknown change once', () => {
    const changes = record();
    const first = nextSession();
    fileTreeChanges.toolTransition('/repo', undefined, toolPart(first, 'shell', 'error', { command: 'mkdir x' }));
    fileTreeChanges.stepCompleted('/repo', first, ['x/.keep']);
    fileTreeChanges.stepCompleted('/repo', first, ['x/.keep']);
    const second = nextSession();
    fileTreeChanges.toolTransition('/repo', undefined, toolPart(second, 'execute', 'completed'));
    fileTreeChanges.stepCompleted('/repo', second, undefined);
    expect(changes).toEqual([{ directory: '/repo' }, { directory: '/repo' }]);
  });

  test('a step without a shell call reports nothing, even when files changed', () => {
    const changes = record();
    const session = nextSession();
    fileTreeChanges.toolTransition('/repo', undefined, toolPart(session, 'edit', 'completed', { path: 'a.ts' }));
    fileTreeChanges.stepCompleted('/repo', session, ['a.ts']);
    expect(changes).toEqual([]);
  });

  test('steps of one session do not settle another session\'s shell call', () => {
    const changes = record();
    const busy = nextSession();
    const other = nextSession();
    fileTreeChanges.toolTransition('/repo', undefined, toolPart(busy, 'shell', 'completed'));
    fileTreeChanges.stepCompleted('/repo', other, []);
    fileTreeChanges.stepCompleted('/repo', busy, ['out.txt']);
    expect(changes).toEqual([{ directory: '/repo' }]);
  });
});

describe('affectedDirectories', () => {
  test('named files map to their parent folders inside the root', () => {
    expect(affectedDirectories({ directory: '/repo', paths: ['/repo/src/a.ts', '/repo/src/b.ts', '/repo/top.ts', '/other/x.ts'] }, '/repo'))
      .toEqual(['/repo/src', '/repo']);
    expect(affectedDirectories({ directory: '/repo', paths: ['/other/x.ts'] }, '/repo')).toEqual([]);
    expect(affectedDirectories({ directory: '/repo', paths: ['/repo-other/x.ts'] }, '/repo')).toEqual([]);
  });

  test('an unknown change covers the root when the directories overlap', () => {
    expect(affectedDirectories({ directory: '/repo' }, '/repo')).toBeNull();
    expect(affectedDirectories({ directory: '/repo/packages/ui' }, '/repo')).toBeNull();
    expect(affectedDirectories({ directory: '/repo' }, '/repo/packages/ui')).toBeNull();
    expect(affectedDirectories({ directory: '/elsewhere' }, '/repo')).toEqual([]);
  });
});
