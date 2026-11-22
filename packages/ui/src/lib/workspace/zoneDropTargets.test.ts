import { describe, expect, test } from 'bun:test';
import { computeCenterDropTargets, computeZoneDropFrames, computeZoneDropTargets, hitTestZoneDropTargets } from './zoneDropTargets';

describe('zone drop targets', () => {
  test('with nothing beside the chat, edge strips stop above the bottom band, which spans the chat', () => {
    const row = { left: 300, top: 50, width: 1400, height: 800 };
    const targets = computeZoneDropTargets(row, row);
    expect(targets.left).toEqual({ left: 300, top: 50, width: 280, height: 560 });
    expect(targets.right).toEqual({ left: 1420, top: 50, width: 280, height: 560 });
    expect(targets.bottom).toEqual({ left: 300, top: 610, width: 1400, height: 240 });
  });

  test('an open bottom zone is the whole bottom target, and edge strips stop above it', () => {
    const row = { left: 300, top: 50, width: 1400, height: 800 };
    const bottomZone = { left: 300, top: 530, width: 1400, height: 320 };
    const targets = computeZoneDropTargets(row, row, bottomZone);
    expect(targets.bottom).toEqual({ left: 300, top: 530, width: 1400, height: 320 });
    expect(targets.left.height).toBe(480);
    expect(targets.right.height).toBe(480);
  });

  test('whatever stands beside the chat takes its side, full height', () => {
    // Left zone 540 px, chat column 800 px (with a bottom zone), the work-status card's 480 px column.
    const row = { left: 0, top: 50, width: 1820, height: 800 };
    const chatColumn = { left: 540, top: 50, width: 800, height: 800 };
    const bottomZone = { left: 540, top: 530, width: 800, height: 320 };
    const targets = computeZoneDropTargets(row, chatColumn, bottomZone);
    expect(targets.left).toEqual({ left: 0, top: 50, width: 540, height: 800 });
    expect(targets.right).toEqual({ left: 1340, top: 50, width: 480, height: 800 });
    expect(targets.bottom).toEqual({ left: 540, top: 530, width: 800, height: 320 });
  });

  test('targets never overlap, so the pointer picks exactly one', () => {
    const row = { left: 300, top: 50, width: 1400, height: 800 };
    const targets = computeZoneDropTargets(row, row);
    expect(hitTestZoneDropTargets(targets, { x: 310, y: 800 })).toBe('bottom');
    expect(hitTestZoneDropTargets(targets, { x: 310, y: 300 })).toBe('left');
    expect(hitTestZoneDropTargets(targets, { x: 1600, y: 100 })).toBe('right');
    expect(hitTestZoneDropTargets(targets, { x: 900, y: 200 })).toBeNull();
  });

  test('in the panel window the center is one target between full-height side strips', () => {
    const row = { left: 0, top: 48, width: 1000, height: 700 };
    const targets = computeCenterDropTargets(row, row);
    expect(targets.left).toEqual({ left: 0, top: 48, width: 250, height: 700 });
    expect(targets.right).toEqual({ left: 750, top: 48, width: 250, height: 700 });
    expect(targets.bottom).toEqual({ left: 250, top: 48, width: 500, height: 700 });
    expect(hitTestZoneDropTargets(targets, { x: 500, y: 60 })).toBe('bottom');
    expect(hitTestZoneDropTargets(targets, { x: 900, y: 700 })).toBe('right');
  });

  test('in the panel window an open side column is that side\'s whole target', () => {
    const row = { left: 0, top: 48, width: 1400, height: 700 };
    const center = { left: 400, top: 48, width: 1000, height: 700 };
    const targets = computeCenterDropTargets(row, center);
    expect(targets.left).toEqual({ left: 0, top: 48, width: 400, height: 700 });
    expect(targets.bottom).toEqual({ left: 400, top: 48, width: 750, height: 700 });
    expect(targets.right).toEqual({ left: 1150, top: 48, width: 250, height: 700 });
  });

  test('in the panel window the center frame stops where a closed side\'s strip begins', () => {
    const row = { left: 0, top: 48, width: 1400, height: 700 };
    const center = { left: 400, top: 48, width: 1000, height: 700 };
    const targets = computeCenterDropTargets(row, center);
    const frames = computeZoneDropFrames(targets, {
      left: { left: 6, top: 48, width: 386, height: 692 },
      bottom: { left: 400, top: 48, width: 994, height: 692 },
      right: null,
    });
    expect(frames.left).toEqual({ left: 6, top: 48, width: 386, height: 692 });
    expect(frames.bottom).toEqual({ left: 400, top: 48, width: 750, height: 692 });
    expect(frames.right).toEqual({ left: 1156, top: 48, width: 238, height: 692 });
    expect(frames.bottom.left + frames.bottom.width).toBeLessThan(frames.right.left);
  });
});
