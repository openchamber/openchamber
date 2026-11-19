import { toast } from '@/components/ui';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { openDesktopPath } from '@/lib/desktop';
import { type useFileExternalActions } from './useFileExternalActions';
import { type useFileTabs } from './useFileTabs';
import { useI18n } from '@/lib/i18n';

export function renderFileOpenInApps({ externalActions, tabs, t }: {
  externalActions: Pick<ReturnType<typeof useFileExternalActions>, 'handleOpenInApp' | 'loadOpenInApps' | 'openInApps' | 'openInCacheStale'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { handleOpenInApp, loadOpenInApps, openInApps, openInCacheStale } = externalActions;
  const { selectedFile } = tabs;
    const openInAppMenuItems = (
      <>
        <DropdownMenuItem
          className="flex items-center gap-2"
          onClick={() => {
            if (!selectedFile?.path) return;
            void openDesktopPath(selectedFile.path).then((opened) => {
              if (!opened) toast.error(t('sidebarFilesTree.toast.operationFailed'));
            });
          }}
        >
          <Icon name="external-link" className="size-4" />
          <span className="typography-ui-label text-foreground">{t('sidebarFilesTree.menu.openInDefaultApp')}</span>
        </DropdownMenuItem>
        {openInApps.length > 0 ? <DropdownMenuSeparator /> : null}
        {openInApps.map((app) => (
          <DropdownMenuItem
            key={app.id}
            className="flex items-center gap-2"
            onClick={() => void handleOpenInApp(app)}
          >
            <Icon name={app.icon} className="size-4" />
            <span className="typography-ui-label text-foreground">{app.label}</span>
          </DropdownMenuItem>
        ))}
        {openInCacheStale ? (
          <DropdownMenuItem
            className="flex items-center gap-2"
            onClick={() => void loadOpenInApps(true)}
          >
            <Icon name="refresh" className="size-4" />
            <span className="typography-ui-label text-foreground">{t('filesView.editor.refreshApps')}</span>
          </DropdownMenuItem>
        ) : null}
      </>
    );

  return { openInAppMenuItems };
}
