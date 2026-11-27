import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { trackerTargetOfUrl, useShowTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { SourceControlIdentity } from '@/lib/api/types';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { useRepositoryUrlMatcher, type RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { afterDelay } from '@/lib/timing/afterDelay';
import { useTrackerUrlMatcher, type TrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { readTrackerItemRequest, subscribeTrackerItemRequests, takeTrackerItemRequest } from '@/lib/trackerItemRequests';
import { openExternalUrl } from '@/lib/url';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { isTrackerConnected, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const INSTALLED_DISPLAY_MODES = ['standalone', 'window-controls-overlay', 'fullscreen', 'minimal-ui'];
const runsAsInstalledApp = (): boolean => INSTALLED_DISPLAY_MODES.some((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches === true)
  || ('standalone' in navigator && navigator.standalone === true);

const webAddressOf = (url: string): string | null => {
  try {
    const target = new URL(url);
    return target.protocol === 'https:' || target.protocol === 'http:' ? target.href : null;
  } catch {
    return null;
  }
};

const leaveTabForItem = (url: string): boolean => {
  if (isDesktopShell() || isVSCodeRuntime() || isCapacitorApp() || runsAsInstalledApp()) return false;
  const target = webAddressOf(url);
  if (!target) return false;
  window.location.replace(target);
  return true;
};

const APP_ACTIVE_WAIT_MS = 5000;

const whenAppActive = async (): Promise<boolean> => {
  const { App } = await import('@capacitor/app');
  if ((await App.getState()).isActive) return true;
  return new Promise<boolean>((resolve) => {
    const handle = App.addListener('appStateChange', (state) => {
      if (!state.isActive) return;
      finish(true);
    });
    const cancelDeadline = afterDelay(APP_ACTIVE_WAIT_MS, () => finish(false));
    function finish(active: boolean) {
      cancelDeadline();
      void handle.then((listener) => listener.remove());
      resolve(active);
    }
  });
};

const openFromPhoneApp = (url: string): boolean => {
  if (!isCapacitorApp()) return false;
  const target = webAddressOf(url);
  if (!target) return false;
  void whenAppActive().catch(() => true).then((active) => {
    if (active) window.location.assign(target);
  });
  return true;
};

const isKnownItem = (url: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher, identities: readonly SourceControlIdentity[]): boolean => {
  if (trackerUrls(url)) return true;
  const item = urls.match(url);
  if (!item) return false;
  return urls.descriptorOf(item.provider).instances.defaultInstance === item.instance
    || identities.some((identity) => identity.provider === item.provider && identity.instance === item.instance);
};

const opensInPanel = (url: string, directory: string | null, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): boolean => {
  const target = trackerTargetOfUrl(url, urls, trackerUrls);
  if (!target) return false;
  if (target.source === 'tracker') return isTrackerConnected(useTrackerAuthStore.getState().entries[target.provider]);
  return resolveProjectForSessionDirectory(useProjectsStore.getState().projects, useSessionUIStore.getState().availableWorktreesByProject, directory) !== null;
};

export function useTrackerItemRequestAnswers(): void {
  const request = React.useSyncExternalStore(subscribeTrackerItemRequests, readTrackerItemRequest, readTrackerItemRequest);
  const showTrackerItem = useShowTrackerItem();
  const urls = useRepositoryUrlMatcher();
  const trackerUrls = useTrackerUrlMatcher();
  const sourceControl = React.useContext(RuntimeAPIContext)?.sourceControl;
  const registryKnown = useSourceControlProviderRegistry((state) => state.holdsList || state.status === 'error');
  const projectsKnown = useProjectsStore((state) => state.hasServerSnapshot || state.serverSnapshotFailed);
  const identitiesKnown = useSourceControlAuthStore((state) => state.identitiesLoaded || state.identitiesError !== null);
  const refreshInstances = useSourceControlAuthStore((state) => state.refreshInstances);
  const identities = useSourceControlAuthStore((state) => state.identities);
  const mobile = useMobileAppActions();
  const unpreparedChatDraft = useSessionUIStore((state) => {
    const draft = state.newSessionDraft;
    return draft.open && draft.target === 'chat' && !draft.preparedChatDirectory
      && !draft.bootstrapPendingDirectory && !draft.directoryOverride ? draft.draftId : null;
  });
  const prepareChatDraftDirectory = useSessionUIStore((state) => state.prepareChatDraftDirectory);
  const [draftSettled, setDraftSettled] = React.useState<{ request: typeof request; draftId: number } | null>(null);

  React.useEffect(() => {
    if (!request || isVSCodeRuntime()) return;
    if (!registryKnown || !projectsKnown) return;
    const recognised = trackerTargetOfUrl(request.url, urls, trackerUrls) !== null
      && isKnownItem(request.url, urls, trackerUrls, identities);
    if (!recognised && !identitiesKnown && sourceControl) {
      void refreshInstances(sourceControl);
      return;
    }
    if (recognised && !mobile && unpreparedChatDraft !== null
      && (draftSettled?.request !== request || draftSettled.draftId !== unpreparedChatDraft)
      && opensInPanel(request.url, request.directory, urls, trackerUrls)) {
      const draftId = unpreparedChatDraft;
      void prepareChatDraftDirectory().catch(() => null).finally(() => setDraftSettled({ request, draftId }));
      return;
    }
    if (!takeTrackerItemRequest(request)) return;
    if (!recognised || showTrackerItem(request.url, request.directory)) {
      request.handoff?.release();
      return;
    }
    if (request.handoff?.open(request.url)) return;
    if (request.loadedTab && leaveTabForItem(request.url)) return;
    if (openFromPhoneApp(request.url)) return;
    void openExternalUrl(request.url);
  }, [draftSettled, identities, identitiesKnown, mobile, prepareChatDraftDirectory, projectsKnown, refreshInstances, registryKnown, request, showTrackerItem, sourceControl, trackerUrls, unpreparedChatDraft, urls]);
}
