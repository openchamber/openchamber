import React from 'react';
import { useI18n } from '@/lib/i18n';
import { resolveContextZoneReturnTarget, useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import type { ContextPanelDirectoryState } from '@/stores/ui/types';
import type { ContextZone, ContextZonePlacement } from '@/lib/workspace/zones';

type TranslateFn = ReturnType<typeof useI18n>['t'];

export const useContextZoneCloseAction = (
  directoryKey: string | null,
  zone: ContextZone,
  panelState: ContextPanelDirectoryState | undefined,
  placement: ContextZonePlacement,
  getModeLabel: (mode: ContextPanelMode, translate: TranslateFn) => string,
  tabT: TranslateFn,
) => {
  const { t } = useI18n();
  const closeContextZone = useUIStore((state) => state.closeContextZone);
  const returnStack = useUIStore((state) => (directoryKey ? state.contextZoneReturnStack[directoryKey]?.[zone] : undefined));

  const returnTarget = React.useMemo(
    () => resolveContextZoneReturnTarget(panelState, placement, zone, returnStack),
    [panelState, placement, zone, returnStack],
  );

  const label = returnTarget
    ? t('contextPanel.actions.backToPanel', { panel: getModeLabel(returnTarget.tab.mode, tabT) })
    : t('contextPanel.actions.closePanel');

  const onClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    const eligibleTabIds = panelState ? new Set(panelState.tabs.map((tab) => tab.id)) : undefined;
    closeContextZone(directoryKey, zone, { returnToPrevious: true, eligibleTabIds });
  }, [closeContextZone, directoryKey, panelState, zone]);

  return { label, onClose };
};
