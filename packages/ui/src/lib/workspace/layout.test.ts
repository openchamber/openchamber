import { describe, expect, test } from 'bun:test';

import { CONTEXT_SURFACES } from '@/lib/surfaces/registry';
import {
  applyWorkspacePreset,
  canPlaceSurfaceInZone,
  createDefaultWorkspaceLayout,
  clampWorkspaceZoneSize,
  mainChatZone,
  moveSurfaceToZone,
  parseStoredWorkspaceLayout,
  readPersistedWorkspace,
  sanitizeWorkspaceLayout,
  sessionChatZone,
  WORKSPACE_ZONES,
  WORKSPACE_ZONE_MIN_SIZE,
  zoneOfMode,
  zoneOfSurface,
  type WorkspaceLayout,
} from './layout';

const allPlacements = (layout: WorkspaceLayout): string[] =>
  WORKSPACE_ZONES.flatMap((zone) => layout[zone]);

describe('default layout', () => {
  test('reproduces the pre-workspace app: chat in the center, everything else right', () => {
    const layout = createDefaultWorkspaceLayout();

    expect(layout.center).toEqual(['chat']);
    expect(layout.left).toEqual([]);
    expect(layout.bottom).toEqual([]);
    expect(layout.right).toEqual(
      CONTEXT_SURFACES.map((surface) => surface.id).filter((id) => id !== 'chat'),
    );
  });

  test('places every registered surface exactly once', () => {
    const placements = allPlacements(createDefaultWorkspaceLayout());

    expect(placements.length).toBe(CONTEXT_SURFACES.length);
    expect(new Set(placements).size).toBe(CONTEXT_SURFACES.length);
  });
});

describe('parseStoredWorkspaceLayout', () => {
  test('falls back to the default layout for missing or malformed state', () => {
    const fallback = createDefaultWorkspaceLayout();

    expect(parseStoredWorkspaceLayout(undefined)).toEqual(fallback);
    expect(parseStoredWorkspaceLayout(null)).toEqual(fallback);
    expect(parseStoredWorkspaceLayout('left')).toEqual(fallback);
    expect(parseStoredWorkspaceLayout([['chat']])).toEqual(fallback);
    expect(parseStoredWorkspaceLayout({ left: 'chat', center: 7 })).toEqual(fallback);
  });

  test('keeps the zones it can read when one of them is corrupt', () => {
    const layout = parseStoredWorkspaceLayout({ left: ['editor'], center: ['chat'], right: 42, bottom: ['terminal'] });

    expect(layout.left).toEqual(['editor']);
    expect(layout.bottom).toContain('terminal');
  });

  test('keeps a valid stored placement', () => {
    const layout = sanitizeWorkspaceLayout({ left: ['editor'], center: ['chat'], right: [], bottom: ['terminal'] });

    expect(layout.left).toEqual(['editor']);
    expect(layout.center).toEqual(['chat']);
    expect(layout.bottom[0]).toBe('terminal');
  });

  test('drops surfaces that no longer exist instead of failing', () => {
    const layout = sanitizeWorkspaceLayout({ left: ['ghost-surface'], center: ['chat'], right: [], bottom: [] });

    expect(layout.left).toEqual([]);
    expect(allPlacements(layout)).not.toContain('ghost-surface');
  });

  test('ignores a duplicate placement, keeping the first zone', () => {
    const layout = sanitizeWorkspaceLayout({ left: ['editor'], center: ['chat'], right: ['editor'], bottom: [] });

    expect(layout.left).toEqual(['editor']);
    expect(layout.right).not.toContain('editor');
  });

  test('sends a surface stored in a zone it does not allow back to its default zone', () => {
    // The conversation is kept to center and right; a stored value must not strand it.
    const layout = sanitizeWorkspaceLayout({ left: [], center: [], right: [], bottom: ['chat'] });

    expect(layout.bottom).not.toContain('chat');
    expect(layout.center).toContain('chat');
  });

  test('keeps a normal surface wherever it was stored', () => {
    const layout = sanitizeWorkspaceLayout({ left: ['diff'], center: ['chat', 'terminal'], right: [], bottom: ['editor'] });

    expect(zoneOfSurface(layout, 'terminal')).toBe('center');
    expect(zoneOfSurface(layout, 'diff')).toBe('left');
    expect(zoneOfSurface(layout, 'editor')).toBe('bottom');
  });

  test('appends surfaces the stored layout never mentioned', () => {
    // A layout saved before `notes` shipped: it must come back, not vanish.
    const layout = sanitizeWorkspaceLayout({ left: ['editor'], center: ['chat'], right: [], bottom: [] });

    expect(allPlacements(layout)).toContain('notes');
    expect(allPlacements(layout).length).toBe(CONTEXT_SURFACES.length);
  });

  test('places an installed plugin surface in the right zone', () => {
    const guest = {
      ...CONTEXT_SURFACES[0],
      id: 'plugin:acme' as const,
      mode: 'plugin:acme' as const,
    };
    const layout = sanitizeWorkspaceLayout({ left: [], center: ['chat'], right: [], bottom: [] }, [guest]);

    expect(layout.right).toContain('plugin:acme');
  });

  test('keeps a plugin surface the user moved', () => {
    const guest = {
      ...CONTEXT_SURFACES[0],
      id: 'plugin:acme' as const,
      mode: 'plugin:acme' as const,
    };
    const layout = sanitizeWorkspaceLayout({ left: [], center: [], right: [], bottom: ['plugin:acme'] }, [guest]);

    expect(layout.bottom).toContain('plugin:acme');
  });
});

describe('moveSurfaceToZone', () => {
  test('moves a surface out of its old zone and appends it to the new one', () => {
    const layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'editor', 'left');

    expect(layout.left).toEqual(['editor']);
    expect(layout.right).not.toContain('editor');
  });

  test('preserves ordering within a zone', () => {
    let layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'terminal', 'bottom');
    layout = moveSurfaceToZone(layout, 'git', 'bottom');

    expect(layout.bottom).toEqual(['terminal', 'git']);
  });

  test('honours an explicit index', () => {
    let layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'terminal', 'bottom');
    layout = moveSurfaceToZone(layout, 'git', 'bottom', 0);

    expect(layout.bottom).toEqual(['git', 'terminal']);
  });

  test('rejects a zone the surface does not allow', () => {
    const before = createDefaultWorkspaceLayout();
    const after = moveSurfaceToZone(before, 'chat', 'left');

    expect(after).toBe(before);
    expect(canPlaceSurfaceInZone('chat', 'left')).toBe(false);
    expect(canPlaceSurfaceInZone('chat', 'bottom')).toBe(false);
  });

  // Maintainer feedback (discussion #3844): panels other than the chat should
  // not be limited to some zones.
  test('lets every normal surface and plugin surface use all four zones', () => {
    const surfaces = [...CONTEXT_SURFACES.filter((surface) => surface.id !== 'chat').map((surface) => surface.id), 'plugin:acme'];
    for (const id of surfaces) {
      for (const zone of WORKSPACE_ZONES) {
        expect(`${id} in ${zone}: ${canPlaceSurfaceInZone(id, zone)}`).toBe(`${id} in ${zone}: true`);
      }
    }
  });

  test('moves files, git, terminal and diff into each zone', () => {
    for (const id of ['editor', 'git', 'terminal', 'diff']) {
      for (const zone of WORKSPACE_ZONES) {
        const layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), id, zone);
        expect(`${id}: ${zoneOfSurface(layout, id)}`).toBe(`${id}: ${zone}`);
      }
    }
  });

  test('moving chat to the right takes it out of the center', () => {
    const layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'chat', 'right');

    expect(layout.center).toEqual([]);
    expect(layout.right).toContain('chat');
    expect(zoneOfSurface(layout, 'chat')).toBe('right');
  });

  test('leaves an unknown surface alone', () => {
    const before = createDefaultWorkspaceLayout();

    expect(moveSurfaceToZone(before, 'ghost-surface', 'left')).toBe(before);
  });
});

describe('zoneOfMode', () => {
  test('maps a panel tab mode to the zone of its surface', () => {
    const layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'editor', 'left');

    expect(zoneOfMode(layout, 'file')).toBe('left');
    expect(zoneOfMode(layout, 'git')).toBe('right');
    // Split sessions go beside the conversation, which holds the center.
    expect(zoneOfMode(layout, 'chat')).toBe('right');
  });

  test('split sessions take the center once the conversation moves out of it', () => {
    const layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'chat', 'right');

    expect(mainChatZone(layout)).toBe('right');
    expect(sessionChatZone(layout)).toBe('center');
    expect(zoneOfMode(layout, 'chat')).toBe('center');
  });

  test('falls back to the right zone for a mode with no placement', () => {
    expect(zoneOfMode(createDefaultWorkspaceLayout(), 'plugin:unknown')).toBe('right');
  });
});

describe('plugin surfaces', () => {
  test('can be moved, and keep their placement through sanitizing', () => {
    const layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'plugin:acme', 'left');

    expect(zoneOfMode(layout, 'plugin:acme')).toBe('left');
    expect(zoneOfSurface(sanitizeWorkspaceLayout(layout), 'plugin:acme')).toBe('left');
  });
});

describe('presets', () => {
  test('developer puts files left, chat center, terminal and git bottom', () => {
    const layout = applyWorkspacePreset(createDefaultWorkspaceLayout(), 'developer');

    expect(layout.left).toEqual(['editor']);
    expect(layout.center).toEqual(['chat']);
    expect(layout.bottom).toEqual(['terminal', 'git']);
  });

  test('code-agent puts the editor center and chat right', () => {
    const layout = applyWorkspacePreset(createDefaultWorkspaceLayout(), 'code-agent');

    expect(layout.center).toEqual(['editor']);
    expect(layout.right).toContain('chat');
    expect(layout.bottom).toEqual(['terminal']);
  });

  test('default restores the original layout from any other arrangement', () => {
    const rearranged = applyWorkspacePreset(createDefaultWorkspaceLayout(), 'developer');

    expect(applyWorkspacePreset(rearranged, 'default')).toEqual(createDefaultWorkspaceLayout());
  });
});

describe('clampWorkspaceZoneSize', () => {
  test('keeps each zone above its usable minimum', () => {
    expect(clampWorkspaceZoneSize('left', 10)).toBe(WORKSPACE_ZONE_MIN_SIZE.left);
    expect(clampWorkspaceZoneSize('bottom', 0)).toBe(WORKSPACE_ZONE_MIN_SIZE.bottom);
    expect(clampWorkspaceZoneSize('right', 900)).toBe(900);
  });

  test('replaces a non-finite stored size with the default', () => {
    expect(Number.isFinite(clampWorkspaceZoneSize('left', Number.NaN))).toBe(true);
  });
});

describe('readPersistedWorkspace', () => {
  type SavedState = { workspaceLayout?: WorkspaceLayout | { left: string[] }; workspaceZoneSizes?: { left?: number; bottom?: number }; theme?: string };
  const payload = (state: SavedState) => JSON.stringify({ state, version: 22 });

  test('reads the layout and sizes another window saved', () => {
    const layout = moveSurfaceToZone(createDefaultWorkspaceLayout(), 'git', 'bottom');
    const read = readPersistedWorkspace(payload({ workspaceLayout: layout, workspaceZoneSizes: { left: 300, bottom: 200 } }));

    expect(zoneOfSurface(read?.layout ?? createDefaultWorkspaceLayout(), 'git')).toBe('bottom');
    expect(read?.sizes?.left).toBe(300);
    expect(read?.sizes?.bottom).toBe(200);
  });

  test('adopts nothing when the saved state has no complete layout', () => {
    // A window on an older build, or a write without the layout, must not
    // reset this window's placements to the defaults.
    expect(readPersistedWorkspace(payload({ theme: 'dark' }))).toBeNull();
    expect(readPersistedWorkspace(payload({ workspaceLayout: { left: [] } }))).toBeNull();
    expect(readPersistedWorkspace('{not json')).toBeNull();
    expect(readPersistedWorkspace(null)).toBeNull();
  });

  test('leaves the sizes alone when the saved state has none', () => {
    const read = readPersistedWorkspace(payload({ workspaceLayout: createDefaultWorkspaceLayout() }));
    expect(read?.sizes).toBeNull();
  });
});
