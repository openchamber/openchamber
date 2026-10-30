import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ensureChatsRootDirectory, isChatDirectoryPath } from '@/lib/chatDirectories';
import { opencodeClient } from '@/lib/opencode/client';
import { getNormalizedParentDirectory, normalizePath } from '@/lib/pathNormalization';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';

// Mounted only inside the open Add project dialog, once per runtime/opening.
export function OpenCodeProjectImport({ busy, onBusyChange }: { busy: boolean; onBusyChange: (busy: boolean) => void }) {
  const { t } = useI18n();
  const [paths, setPaths] = React.useState<string[]>([]);
  const [failed, setFailed] = React.useState(false);
  const runtime = React.useRef(getRuntimeKey()).current;
  const mounted = React.useRef(false);
  const hasServerSnapshot = useProjectsStore((state) => state.hasServerSnapshot);

  React.useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const load = async () => {
      if (!hasServerSnapshot) return;
      const settings = await loadDesktopSettings();
      if (!settings || settings.openCodeProjectImportCompleted || cancelled || runtime !== getRuntimeKey()) return;
      await ensureChatsRootDirectory();
      if (cancelled || runtime !== getRuntimeKey()) return;
      const projects = await opencodeClient.listProjects();
      if (cancelled || runtime !== getRuntimeKey()) return;
      const configured = new Set(useProjectsStore.getState().projects.map((p) => normalizePath(p.path)));
      const candidates = [...new Set(projects.map((p) => normalizePath(p.worktree)))].filter(
        (path): path is string => Boolean(path && getNormalizedParentDirectory(path)
          && !configured.has(path) && !isChatDirectoryPath(path)),
      );
      // The client batches these filesystem probes. They do not start OpenCode
      // locations, and an unavailable or unknown folder is never offered.
      const available = await Promise.all(candidates.map(async (path) =>
        await opencodeClient.getDirectoryAvailability(path) === 'available' ? path : null));
      if (!cancelled && runtime === getRuntimeKey()) {
        setPaths(available.filter((path): path is string => path !== null));
      }
    };
    void load().catch(() => { /* Reopening Add project retries a failed read. */ });
    return () => { cancelled = true; mounted.current = false; };
  }, [runtime, hasServerSnapshot]);

  const finish = async (importProjects: boolean) => {
    if (busy || runtime !== getRuntimeKey()) return;
    onBusyChange(true);
    setFailed(false);
    try {
      if (importProjects) {
        const added = await useProjectsStore.getState().addProjects(paths, { fromOpenCode: true });
        if (runtime === getRuntimeKey() && added.length > 0) {
          toast.success(t('directoryExplorerDialog.toast.addedProjects', { count: added.length }));
        }
      } else {
        const result = await updateDesktopSettings({ openCodeProjectImportCompleted: true });
        if (!result.ok) throw new Error('Failed to dismiss project import');
      }
      if (mounted.current && runtime === getRuntimeKey()) setPaths([]);
    } catch {
      if (mounted.current && runtime === getRuntimeKey()) setFailed(true);
    } finally {
      // The dialog owner stays mounted when this suggestion closes. Release
      // its pending-operation guard even after this child has unmounted.
      onBusyChange(false);
    }
  };

  if (paths.length === 0) return null;
  return (
    <section className="mb-2 space-y-2 px-2 pt-1" aria-label={t('directoryExplorerDialog.import.title')}>
      <p className="typography-ui-label">{t('directoryExplorerDialog.import.count', { count: paths.length })}</p>
      <ul className="max-h-24 overflow-auto typography-meta">
        {paths.map((path) => <li key={path} dir="ltr" className="truncate" title={path}>{path}</li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="max-w-full max-sm:min-h-11" disabled={busy} title={t('directoryExplorerDialog.import.title')} onClick={() => void finish(true)}>
          <span className="truncate">{t('directoryExplorerDialog.import.title')}</span>
        </Button>
        <Button size="sm" className="max-sm:min-h-11" variant="ghost" disabled={busy} onClick={() => void finish(false)}>{t('directoryExplorerDialog.import.dismiss')}</Button>
      </div>
      <p role="status" className="h-5 truncate typography-meta text-status-error" title={failed ? t('directoryExplorerDialog.import.failed') : undefined}>
        {failed ? t('directoryExplorerDialog.import.failed') : '\u00a0'}
      </p>
    </section>
  );
}
