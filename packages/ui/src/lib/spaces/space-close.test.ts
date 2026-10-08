import { describe, expect, test } from 'bun:test';

import { spacesToStopOnClose } from './space-close';
import type { SpaceEntry } from './spaces-api';

const space = (id: string, change: Partial<SpaceEntry> = {}): SpaceEntry => ({
  id, name: id, placeId: 'docker', projectDirectory: '/home/me/app', directory: `/spaces/${id}/app`, projectFolder: { path: '/home/me/app', found: true },
  state: 'running', stoppedIdle: false, step: null, failure: null, network: null, grants: [], access: null, needsAccess: [], damage: null, setup: null,
  ...change,
});

describe('closing a project', () => {
  test('stops its running spaces, but not one whose agent is working, nor another project\'s', () => {
    const journey = new Map([
      ['aaaaaaaaaaaa', space('aaaaaaaaaaaa')],
      ['bbbbbbbbbbbb', space('bbbbbbbbbbbb')],
      ['cccccccccccc', space('cccccccccccc', { state: 'exited' })],
      ['dddddddddddd', space('dddddddddddd', { state: 'preparing' })],
      ['eeeeeeeeeeee', space('eeeeeeeeeeee', { projectDirectory: '/home/me/other', projectFolder: { path: '/home/me/other', found: true } })],
    ]);
    const working = new Set(['bbbbbbbbbbbb']);
    expect(spacesToStopOnClose(journey, '/home/me/app/', (id) => working.has(id)).map((entry) => entry.id)).toEqual(['aaaaaaaaaaaa']);
  });

  test('finds the spaces by the folder they were made for, once the host no longer has the project', () => {
    const journey = new Map([
      ['aaaaaaaaaaaa', space('aaaaaaaaaaaa', { projectDirectory: null, directory: null })],
      // A record the host could not read names no folder: the registered project still does.
      ['bbbbbbbbbbbb', space('bbbbbbbbbbbb', { projectFolder: { path: null, found: null } })],
      ['cccccccccccc', space('cccccccccccc', { projectDirectory: null, directory: null, projectFolder: { path: null, found: null } })],
    ]);
    expect(spacesToStopOnClose(journey, '/home/me/app', () => false).map((entry) => entry.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(spacesToStopOnClose(journey, '', () => false)).toEqual([]);
  });
});
