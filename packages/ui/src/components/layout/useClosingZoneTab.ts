import React from 'react';

export const useClosingZoneTab = <T extends { id: string }>(activeTab: T | null, isOpen: boolean): T | null => {
  const [shownId, setShownId] = React.useState<string | null>(null);
  const activeId = activeTab?.id ?? null;
  if (isOpen && shownId !== activeId) setShownId(activeId);
  if (isOpen || shownId === null || shownId === activeId) return activeTab;
  return null;
};
