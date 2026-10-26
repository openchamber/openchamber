import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import {
  areAllWorkStatusSectionsHidden,
  resolveWorkStatusSectionOrder,
  type WorkStatusPanelSectionId,
} from './sections';
import { useUnavailableWorkStatusSections } from './useUnavailableWorkStatusSections';
import { useWorkStatusExtensionSections, type WorkStatusExtensionSections } from './useWorkStatusExtensionSections';

/**
 * The hidden-section list in effect here, with its setters. The phone's
 * Status tab keeps its own per-device list (`mobileWorkStatusHiddenSections`,
 * Subagents hidden by default); the desktop panel keeps the profile one.
 */
export const useWorkStatusHiddenSections = () => {
  const isMobile = useUIStore((state) => state.isMobile);
  const hidden = useUIStore((state) => (isMobile ? state.mobileWorkStatusHiddenSections : state.workStatusHiddenSections));
  const setSectionVisible = useUIStore((state) => (isMobile ? state.setMobileWorkStatusSectionVisible : state.setWorkStatusSectionVisible));
  const setHiddenSections = useUIStore((state) => (isMobile ? state.setMobileWorkStatusHiddenSections : state.setWorkStatusHiddenSections));
  return { hidden, setSectionVisible, setHiddenSections };
};

export type WorkStatusSectionLayout = {
  extensionSections: WorkStatusExtensionSections;
  sectionOrder: WorkStatusPanelSectionId[];
  hiddenSections: readonly string[];
  allSectionsHidden: boolean;
};

/** What the panel, or the phone's Status tab, shows and in which order. */
export const useWorkStatusSectionLayout = (): WorkStatusSectionLayout => {
  const { hidden } = useWorkStatusHiddenSections();
  const storedOrder = useUIStore((state) => state.workStatusSectionOrder);
  const extensionSections = useWorkStatusExtensionSections();
  const unavailableSections = useUnavailableWorkStatusSections();
  const sectionOrder = React.useMemo(
    () => resolveWorkStatusSectionOrder(storedOrder, extensionSections.ids, unavailableSections),
    [extensionSections.ids, storedOrder, unavailableSections],
  );
  return {
    extensionSections,
    sectionOrder,
    hiddenSections: hidden,
    allSectionsHidden: areAllWorkStatusSectionsHidden(hidden, extensionSections.ids, unavailableSections),
  };
};
