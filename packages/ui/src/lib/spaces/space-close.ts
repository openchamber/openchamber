
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useUIStore } from '@/stores/useUIStore';
import { spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { isAgentWorkingInSpace } from './space-apply';
import { runSpaceAction } from './space-repair';
import type { SpaceEntry } from './spaces-api';
import { refreshSpacesJourney, useSpacesStore } from './spaces-store';

const t = (key: I18nKey, params?: I18nParams): string => formatMessage(useI18nStore.getState().dictionary, key, params);

export const spacesToStopOnClose = (journey: ReadonlyMap<string, SpaceEntry>, projectPath: string, isWorking: (spaceId: string) => boolean): SpaceEntry[] => {
  const project = normalizePath(projectPath);
  if (project === null) return [];
  return Array.from(journey.values()).filter((entry) => entry.state === 'running'
    && normalizePath(entry.projectFolder.path ?? entry.projectDirectory) === project
    && !isWorking(entry.id));
};

export const stopSpacesOfClosedProject = async (projectPath: string, projectLabel: string): Promise<void> => {
  if (!useUIStore.getState().isolatedSpacesEnabled || isVSCodeRuntime()) return;
  const listed = await refreshSpacesJourney().then(() => true, () => false);
  if (!listed) return;
  const journey = useSpacesStore.getState().journey;
  if (!journey) return;
  const targets = spacesToStopOnClose(journey, projectPath, (spaceId) => isAgentWorkingInSpace(useGlobalSessionStatusStore.getState(), spaceId));
  if (targets.length === 0) return;
  await Promise.all(targets.map((entry) => runSpaceAction(entry.id, 'stop')));
  let stopped = 0;
  for (const entry of targets) {
    const state = useSpacesStore.getState().actions.get(entry.id);
    if (state?.kind === 'failed') toast.error(t('spaces.close.stopFailed', { name: entry.name, reason: spaceFailureText(t, state.failure) }));
    else stopped += 1;
  }
  if (stopped === 1) toast.success(t('spaces.close.stoppedSingle', { project: projectLabel }));
  else if (stopped > 1) toast.success(t('spaces.close.stoppedPlural', { count: stopped, project: projectLabel }));
};
