import { describe, expect, test } from 'bun:test';
import {
  carrySurfaceToZone,
  CLOSED_ZONE_VIEW,
  isZoneShown,
  resolveZoneActiveTab,
  keepZoneViewsOnTabs,
  zonePlacementSchema,
  zoneViewsSchema,
  settleZones,
  shownContextModes,
  type ContextZonePlacement,
  type ZonedPanel,
} from './zones';

const tab = (id: string, mode: 'file' | 'git' | 'terminal' | 'diff', touchedAt = 1) => ({ id, mode, touchedAt });

const panel = (patch: Partial<ZonedPanel> = {}): ZonedPanel => ({
  isOpen: false,
  expanded: false,
  activeTabId: null,
  tabs: [tab('git', 'git'), tab('file:a', 'file'), tab('terminal', 'terminal')],
  zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
  ...patch,
});

describe('workspace zones', () => {
  test('a zone never shows a tab whose surface is placed elsewhere', () => {
    const placement: ContextZonePlacement = { file: 'left' };
    const state = panel({ isOpen: true, activeTabId: 'file:a' });

    // The right zone named the file tab before Files moved left.
    expect(resolveZoneActiveTab(state, placement, 'right')?.id).toBe('terminal');
    expect(resolveZoneActiveTab(state, placement, 'left')?.id).toBe('file:a');
  });

  test('shown modes list one surface per open zone', () => {
    const placement: ContextZonePlacement = { terminal: 'bottom' };
    const state = panel({
      isOpen: true,
      activeTabId: 'git',
      zones: { left: CLOSED_ZONE_VIEW, bottom: { isOpen: true, expanded: false, activeTabId: 'terminal' } },
    });

    expect([...shownContextModes(state, placement)].sort()).toEqual(['git', 'terminal']);
    expect(isZoneShown(state, placement, 'left')).toBe(false);
  });

  test('settling closes a zone left without tabs and drops its expansion', () => {
    const state = panel({ zones: { left: { isOpen: true, expanded: true, activeTabId: 'gone' }, bottom: CLOSED_ZONE_VIEW } });

    expect(settleZones(state, {}).zones.left).toEqual(CLOSED_ZONE_VIEW);
  });

  test('a surface on screen takes its zone along, and the zone it left closes', () => {
    const state = panel({ isOpen: true, expanded: true, activeTabId: 'file:a' });
    const moved = carrySurfaceToZone(state, 'file', 'right', 'left', { file: 'left' });

    expect(moved.zones.left).toEqual({ isOpen: true, expanded: false, activeTabId: 'file:a' });
    expect(moved.isOpen).toBe(false);
    expect(moved.expanded).toBe(false);
  });

  test('a surface off screen moves without opening anything', () => {
    const state = panel({ isOpen: true, activeTabId: 'git' });
    const moved = carrySurfaceToZone(state, 'terminal', 'right', 'bottom', { terminal: 'bottom' });

    expect(moved.zones.bottom.isOpen).toBe(false);
    expect(moved.isOpen).toBe(true);
    expect(moved.activeTabId).toBe('git');
  });

  test('placement keeps known surfaces in a moved zone only', () => {
    expect(zonePlacementSchema.parse({
      file: 'left',
      terminal: 'bottom',
      git: 'right',
      diff: 'top',
      'plugin:notes-x': 'left',
      'not a mode': 'left',
    })).toEqual({ file: 'left', terminal: 'bottom', 'plugin:notes-x': 'left' });
    expect(zonePlacementSchema.parse('left')).toEqual({});
    expect(zonePlacementSchema.parse(undefined)).toEqual({});
  });

  test('stored zone views load closed when missing, malformed or pointing at a closed tab', () => {
    const ids = new Set(['git']);
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse(undefined), ids)).toEqual({ left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW });
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse({ left: 'open' }), ids)).toEqual({ left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW });
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse({ left: { isOpen: true, expanded: true, activeTabId: 'gone' } }), ids).left).toEqual(CLOSED_ZONE_VIEW);
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse({ bottom: { isOpen: true, expanded: false, activeTabId: 'git' } }), ids).bottom)
      .toEqual({ isOpen: true, expanded: false, activeTabId: 'git' });
  });
});
