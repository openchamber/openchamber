import React from 'react';

/**
 * The tab a zone draws: its active tab while open, and while closed only the
 * tab it showed when it closed. Closing a zone's last tab of a surface leaves
 * another surface's tab active in the store (`settleZones` keeps every zone
 * naming a tab of its own), and drawing that one would paint it while the
 * card fades out. A zone that has not been open since mount draws its active
 * tab as before.
 */
export const useClosingZoneTab = <T extends { id: string }>(activeTab: T | null, isOpen: boolean): T | null => {
  const [shownId, setShownId] = React.useState<string | null>(null);
  const activeId = activeTab?.id ?? null;
  if (isOpen && shownId !== activeId) setShownId(activeId);
  if (isOpen || shownId === null || shownId === activeId) return activeTab;
  return null;
};
