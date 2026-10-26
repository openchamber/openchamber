import { useUIStore } from '@/stores/useUIStore';
import type { WorkStatusSectionId } from './sections';

const NONE_UNAVAILABLE: readonly WorkStatusSectionId[] = [];
const WORKFLOWS_UNAVAILABLE: readonly WorkStatusSectionId[] = ['workflows'];
const MOBILE_UNAVAILABLE: readonly WorkStatusSectionId[] = ['usage'];
const MOBILE_WORKFLOWS_UNAVAILABLE: readonly WorkStatusSectionId[] = ['usage', 'workflows'];

/**
 * Built-in sections of features this build may not have. A section of a
 * feature the build lacks is listed nowhere, the sections dialog included, so
 * an unreleased feature does not show up by name.
 *
 * The phone's Status tab also leaves out Usage: the phone has its own Usage
 * page, which reads better there than the panel's compact rows.
 */
export const useUnavailableWorkStatusSections = (): readonly WorkStatusSectionId[] => {
  const workflows = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  const isMobile = useUIStore((state) => state.isMobile);
  if (isMobile) return workflows ? MOBILE_UNAVAILABLE : MOBILE_WORKFLOWS_UNAVAILABLE;
  return workflows ? NONE_UNAVAILABLE : WORKFLOWS_UNAVAILABLE;
};
