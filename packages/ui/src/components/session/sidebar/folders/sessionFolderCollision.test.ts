import { describe, expect, test } from 'bun:test';
import type { Active, ClientRect, DroppableContainer } from '@dnd-kit/core';
import { sessionFolderCollision } from './sessionFolderCollision';

const rect = (top: number): ClientRect => ({ top, bottom: top + 28, left: 0, right: 240, width: 240, height: 28 });

const container = (id: string, type: string, sortGroup?: string): DroppableContainer => ({
  id,
  key: id,
  data: { current: { type, sortGroup } },
  disabled: false,
  node: { current: null },
  rect: { current: null },
});

const active = (type: string, sortGroup?: string): Active => ({
  id: 'dragged',
  data: { current: { type, sortGroup } },
  rect: { current: { initial: null, translated: null } },
});

// A folder header at the top, a project header below it, then the dragged row.
const containers = [container('folder', 'folder'), container('project', 'project')];
const droppableRects = new Map([['folder', rect(0)], ['project', rect(40)]]);

const collide = (type: string, pointerY: number | null, rowTop = 120) => sessionFolderCollision({
  active: active(type),
  collisionRect: rect(rowTop),
  droppableRects,
  droppableContainers: containers,
  pointerCoordinates: pointerY === null ? null : { x: 100, y: pointerY },
}).map((collision) => collision.id);

describe('sessionFolderCollision', () => {
  test('a session drag lands in the folder under the pointer', () => {
    expect(collide('session', 10)).toEqual(['folder']);
  });

  test('a session drag released away from every folder lands nowhere', () => {
    expect(collide('session', 130)).toEqual([]);
    // Over a project header: not a folder, so still nowhere.
    expect(collide('session', 50)).toEqual([]);
  });

  test('a keyboard drag lands in the folder its row was moved onto', () => {
    expect(collide('session', null, 4)).toEqual(['folder']);
    expect(collide('session', null, 120)).toEqual([]);
  });

  test('other drags keep the nearest target', () => {
    expect(collide('project', 130)[0]).toBe('project');
  });

  test('a header lands only among the headers of its sort group', () => {
    // A project of Projects right under the dragged one, a group's project and
    // a section caption further off: only the farther Projects one is a target.
    const sorted = [
      container('group-project', 'project', 'section:clients'),
      container('caption', 'section', 'sections'),
      container('far-project', 'project', 'projects'),
    ];
    const rects = new Map([['group-project', rect(120)], ['caption', rect(150)], ['far-project', rect(400)]]);
    const hit = (type: string, sortGroup: string) => sessionFolderCollision({
      active: active(type, sortGroup),
      collisionRect: rect(130),
      droppableRects: rects,
      droppableContainers: sorted,
      pointerCoordinates: { x: 100, y: 140 },
    }).map((collision) => collision.id);
    expect(hit('project', 'projects')).toEqual(['far-project']);
    expect(hit('project', 'section:clients')).toEqual(['group-project']);
    expect(hit('section', 'sections')).toEqual(['caption']);
  });
});
