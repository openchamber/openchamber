import React from 'react';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { openDesktopFileInApp, openDesktopPath } from '@/lib/desktop';
import { useOpenInAppsStore } from '@/stores/useOpenInAppsStore';
import { useI18n } from '@/lib/i18n';
import { getParentDirectoryPath } from './fileViewPaths';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';

export function useFileExternalActions({ scope, tabs, files, t }: {
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { root } = scope;
  const { selectedFile } = tabs;
  const canReveal = Boolean(files.revealPath);
  const openInApps = useOpenInAppsStore((state) => state.availableApps);
  const openInCacheStale = useOpenInAppsStore((state) => state.isCacheStale);
  const initializeOpenInApps = useOpenInAppsStore((state) => state.initialize);
  const loadOpenInApps = useOpenInAppsStore((state) => state.loadInstalledApps);

  React.useEffect(() => {
    initializeOpenInApps();
  }, [initializeOpenInApps]);

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!files.revealPath) return;
    void files.revealPath(targetPath).catch(() => {
      toast.error(t('sidebarFilesTree.toast.revealFailed'));
    });
  }, [files, t]);

  const handleOpenInApp = React.useCallback(async (app: { id: string; appName: string }) => {
    if (!selectedFile?.path) {
      return;
    }

    const openedInApp = await openDesktopFileInApp(selectedFile.path, app.id, app.appName);
    if (openedInApp) {
      return;
    }

    const openedFile = await openDesktopPath(selectedFile.path, app.appName);
    if (openedFile) {
      return;
    }

    const fileDirectory = getParentDirectoryPath(selectedFile.path) || root;
    if (fileDirectory) {
      const openedDirectory = await openDesktopPath(fileDirectory, app.appName);
      if (openedDirectory) {
        return;
      }
    }
    toast.error(t('filesView.toast.openInAppFailed', { app: app.appName }));
  }, [root, selectedFile?.path, t]);

  return { canReveal, openInApps, openInCacheStale, loadOpenInApps, handleRevealPath, handleOpenInApp };
}
