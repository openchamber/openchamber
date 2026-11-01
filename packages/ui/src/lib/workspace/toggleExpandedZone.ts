import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { canZoneExpand, getZoneView, resolveZoneActiveTabId, zoneOfMode, type ContextZone } from './zones';

// The right zone first: it is the panel people mean when nothing says otherwise.
const ZONE_PREFERENCE: readonly ContextZone[] = ['right', 'left', 'bottom'];

const isContextZone = (value: string | null | undefined): value is ContextZone => (
  value === 'left' || value === 'right' || value === 'bottom'
);

/**
 * The expand shortcut and menu item, for whatever surface a zone shows: an
 * expanded zone collapses; else the zone that holds focus expands, else the
 * first one on screen (right, left, bottom); with none on screen the right
 * zone's last surface opens, expanded. A zone showing only the file tree
 * cannot expand, so it is skipped, and its suspended flag is left alone.
 */
export const toggleExpandedContextZone = (directory: string | null): void => {
  if (!directory) return;
  const key = normalizeContextPanelDirectoryKey(directory);
  const state = useUIStore.getState();
  const panel = state.contextPanelByDirectory[key];
  const expandable = (zone: ContextZone): boolean => canZoneExpand(panel, state, zone);

  const expanded = panel ? ZONE_PREFERENCE.find((zone) => expandable(zone) && getZoneView(panel, zone).expanded) : undefined;
  if (expanded) {
    state.toggleContextPanelExpanded(key, expanded);
    return;
  }

  const focusedZone = globalThis.document?.activeElement?.closest('[data-context-zone]')?.getAttribute('data-context-zone');
  const target = (isContextZone(focusedZone) && expandable(focusedZone) ? focusedZone : null) ?? ZONE_PREFERENCE.find(expandable);
  if (target) {
    state.toggleContextPanelExpanded(key, target);
    return;
  }

  // Nothing to expand on screen: open the right zone's last surface, or Git
  // wherever it is placed, and expand the zone it opened in.
  const rightTabId = panel
    ? resolveZoneActiveTabId(panel.tabs, state.contextSurfaceZones, 'right', getZoneView(panel, 'right').activeTabId)
    : null;
  if (rightTabId) state.setActiveContextPanelTab(key, rightTabId);
  else state.openContextSurface(key, 'git');
  const zone = rightTabId ? 'right' : zoneOfMode(state.contextSurfaceZones, 'git');
  const opened = useUIStore.getState();
  const openedPanel = opened.contextPanelByDirectory[key];
  // A closed zone can keep a stale expanded flag; expand, never toggle it off.
  if (openedPanel && canZoneExpand(openedPanel, opened, zone) && !getZoneView(openedPanel, zone).expanded) {
    opened.toggleContextPanelExpanded(key, zone);
  }
};
