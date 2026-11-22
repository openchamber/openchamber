import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { canZoneExpand, getZoneView, resolveZoneActiveTabId, zoneOfMode, type ContextZone } from './zones';

const ZONE_PREFERENCE: readonly ContextZone[] = ['right', 'left', 'bottom'];

const isContextZone = (value: string | null | undefined): value is ContextZone => (
  value === 'left' || value === 'right' || value === 'bottom'
);

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

  const rightTabId = panel
    ? resolveZoneActiveTabId(panel.tabs, state.contextSurfaceZones, 'right', getZoneView(panel, 'right').activeTabId)
    : null;
  if (rightTabId) state.setActiveContextPanelTab(key, rightTabId);
  else state.openContextSurface(key, 'git');
  const zone = rightTabId ? 'right' : zoneOfMode(state.contextSurfaceZones, 'git');
  const opened = useUIStore.getState();
  const openedPanel = opened.contextPanelByDirectory[key];
  if (openedPanel && canZoneExpand(openedPanel, opened, zone) && !getZoneView(openedPanel, zone).expanded) {
    opened.toggleContextPanelExpanded(key, zone);
  }
};
