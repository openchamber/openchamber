import { describe, expect, test } from 'bun:test';
import { CLOSED_ZONE_VIEW, isZoneShown, resolveZoneActiveTab } from '@/lib/workspace/zones';
import type { ContextPanelDirectoryState, ContextPanelTab } from '@/stores/ui/types';
import { carryShownSurfaces, explicitPanelWindowPlacement, panelWindowPlacement } from './layoutState';

const tab = (id: string, mode: ContextPanelTab['mode']): ContextPanelTab => ({
  id,
  mode,
  targetPath: null,
  targetDirectory: null,
  dedupeKey: id,
  label: null,
  sessionTitleFallback: null,
  readOnly: false,
  stagedDiff: false,
  diffScope: null,
  preview: false,
  ownerSessionId: null,
  touchedAt: 1,
});

const panel = (overrides: Partial<ContextPanelDirectoryState>): ContextPanelDirectoryState => ({
  isOpen: false,
  expanded: false,
  tabs: [],
  activeTabId: null,
  zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
  touchedAt: 1,
  ...overrides,
});

describe('panel window placement', () => {
  test('puts every surface it never placed in the center', () => {
    const placement = panelWindowPlacement({});
    expect(placement.git).toBe('bottom');
    expect(placement.file).toBe('bottom');
  });

  test('keeps a surface the user moved to the right on the right', () => {
    const placement = panelWindowPlacement(explicitPanelWindowPlacement({ git: 'left' }, {}));
    expect(placement.git).toBe('left');
    expect(placement.file).toBeUndefined();
    expect(panelWindowPlacement({ file: 'right' }).file).toBeUndefined();
    expect(explicitPanelWindowPlacement({}, { 'plugin:notes-x': 'bottom' })['plugin:notes-x']).toBe('right');
  });
});

describe('carryShownSurfaces', () => {
  test('shows in the panel window what the main window showed, in that window\'s zones', () => {
    const main = {
      '/repo': panel({
        isOpen: true,
        activeTabId: 'file',
        tabs: [tab('git', 'git'), tab('file', 'file'), tab('term', 'terminal')],
        zones: { left: { isOpen: true, expanded: false, activeTabId: 'git' }, bottom: { isOpen: true, expanded: true, activeTabId: 'term' } },
      }),
    };
    const mainPlacement = { git: 'left', terminal: 'bottom' } as const;
    const panelPlacement = panelWindowPlacement({ git: 'right', terminal: 'left' });

    const carried = carryShownSurfaces(main, mainPlacement, panelPlacement)['/repo'];

    expect(resolveZoneActiveTab(carried, panelPlacement, 'bottom')?.id).toBe('file');
    expect(resolveZoneActiveTab(carried, panelPlacement, 'right')?.id).toBe('git');
    expect(resolveZoneActiveTab(carried, panelPlacement, 'left')?.id).toBe('term');
    expect(isZoneShown(carried, panelPlacement, 'bottom')).toBe(true);
    expect(isZoneShown(carried, panelPlacement, 'right')).toBe(true);
    expect(carried.zones.bottom.expanded).toBe(false);
  });

  test('two shown surfaces that land in one zone show the first, and nothing opens that was closed', () => {
    const main = {
      '/repo': panel({
        isOpen: true,
        activeTabId: 'file',
        tabs: [tab('git', 'git'), tab('file', 'file'), tab('notes', 'notes')],
        zones: { left: { isOpen: true, expanded: false, activeTabId: 'git' }, bottom: CLOSED_ZONE_VIEW },
      }),
    };
    const panelPlacement = panelWindowPlacement({});

    const carried = carryShownSurfaces(main, { git: 'left' }, panelPlacement)['/repo'];

    expect(isZoneShown(carried, panelPlacement, 'left')).toBe(false);
    expect(isZoneShown(carried, panelPlacement, 'right')).toBe(false);
    expect(resolveZoneActiveTab(carried, panelPlacement, 'bottom')?.id).toBe('git');
    expect(carried.tabs.map((entry) => entry.id)).toEqual(['git', 'file', 'notes']);
  });
});
