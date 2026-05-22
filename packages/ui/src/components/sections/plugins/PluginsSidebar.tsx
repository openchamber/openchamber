import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AddPluginDialog } from './AddPluginDialog';
import { RegistryBadge } from './RegistryBadge';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { useI18n } from '@/lib/i18n';
import {
  usePluginsStore,
  type PluginEntry,
  type PluginFile,
} from '@/stores/usePluginsStore';

interface PluginsSidebarProps {
  onItemSelect?: () => void;
  onAddClick?: () => void;
}

type DeleteTarget =
  | { kind: 'entry'; id: string; label: string }
  | { kind: 'file'; id: string; label: string }
  | null;

const entryIcon = (entry: PluginEntry): IconName =>
  entry.parsedKind === 'npm' ? 'code-box' : 'folder';

export const PluginsSidebar: React.FC<PluginsSidebarProps> = ({
  onItemSelect,
  onAddClick,
}) => {
  const { t } = useI18n();

  const { entries, files, selectedId, setSelected, deleteEntry, deleteFile, loadPlugins } =
    usePluginsStore(
      useShallow((s) => ({
        entries: s.entries,
        files: s.files,
        selectedId: s.selectedId,
        setSelected: s.setSelected,
        deleteEntry: s.deleteEntry,
        deleteFile: s.deleteFile,
        loadPlugins: s.loadPlugins,
      })),
    );

  const registryInfo = usePluginsStore((s) => s.registryInfo);
  const isLoadingRegistry = usePluginsStore((s) => s.isLoadingRegistry);
  const loadRegistryInfo = usePluginsStore((s) => s.loadRegistryInfo);
  const updateToLatest = usePluginsStore((s) => s.updateToLatest);

  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isAddOpen, setIsAddOpen] = React.useState(false);

  React.useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const updateCounts = React.useMemo(() => {
    const counts = { userEntries: 0, projectEntries: 0 };
    for (const entry of entries) {
      const info = registryInfo[entry.spec];
      if (info?.kind === 'npm-ok' && info.hasUpdate) {
        if (entry.scope === 'user') counts.userEntries++;
        else if (entry.scope === 'project') counts.projectEntries++;
      }
    }
    return counts;
  }, [entries, registryInfo]);

  const userEntries = React.useMemo(
    () => entries.filter((e) => e.scope === 'user'),
    [entries],
  );
  const projectEntries = React.useMemo(
    () => entries.filter((e) => e.scope === 'project'),
    [entries],
  );
  const userFiles = React.useMemo(
    () => files.filter((f) => f.scope === 'user'),
    [files],
  );
  const projectFiles = React.useMemo(
    () => files.filter((f) => f.scope === 'project'),
    [files],
  );

  const total = entries.length + files.length;
  const isEmpty = total === 0;

  const handleAdd = React.useCallback(() => {
    if (onAddClick) {
      onAddClick();
    } else {
      setIsAddOpen(true);
    }
  }, [onAddClick]);

  const handleSelect = React.useCallback(
    (id: string) => {
      setSelected(id);
      onItemSelect?.();
    },
    [onItemSelect, setSelected],
  );

  const handleUpdateToLatest = React.useCallback(
    async (id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      const info = registryInfo[entry.spec];
      if (!info || info.kind !== 'npm-ok' || !info.hasUpdate || !info.latestVersion) {
        return;
      }
      const latest = info.latestVersion;
      const result = await updateToLatest(id);
      if (result.ok) {
        toast.success(
          t('settings.plugins.toast.updatedToLatest', { version: latest }),
        );
      } else {
        toast.error(t('settings.plugins.toast.refreshFailed'));
      }
    },
    [entries, registryInfo, t, updateToLatest],
  );

  const handleRefresh = React.useCallback(async () => {
    toast.info(t('settings.plugins.toast.refreshing'));
    try {
      await loadRegistryInfo({ force: true });
    } catch {
      toast.error(t('settings.plugins.toast.refreshFailed'));
    }
  }, [loadRegistryInfo, t]);

  const handleDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const result =
      deleteTarget.kind === 'entry'
        ? await deleteEntry(deleteTarget.id)
        : await deleteFile(deleteTarget.id);
    if (result.ok) {
      toast.success(
        result.message ||
          t('settings.plugins.sidebar.toast.deleted', { name: deleteTarget.label }),
      );
    } else {
      toast.error(t('settings.plugins.sidebar.toast.deleteFailed'));
    }
    setDeleteTarget(null);
    setIsDeleting(false);
  }, [deleteEntry, deleteFile, deleteTarget, t]);

  const renderEntry = (entry: PluginEntry) => {
    const info = registryInfo[entry.spec];
    const canUpdate =
      info?.kind === 'npm-ok' && info.hasUpdate && !!info.latestVersion;
    const actions: Array<{
      label: string;
      icon?: IconName;
      destructive?: boolean;
      onClick: () => void;
    }> = [];
    if (canUpdate) {
      actions.push({
        label: t('settings.plugins.sidebar.actions.updateToLatest'),
        icon: 'arrow-up-s',
        onClick: () => void handleUpdateToLatest(entry.id),
      });
    }
    actions.push({
      label: t('settings.common.actions.delete'),
      icon: 'delete-bin',
      destructive: true,
      onClick: () =>
        setDeleteTarget({ kind: 'entry', id: entry.id, label: entry.spec }),
    });
    return (
      <SettingsSidebarItem
        key={entry.id}
        title={
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span className="truncate">{entry.spec}</span>
            <RegistryBadge spec={entry.spec} />
          </span>
        }
        metadata={
          entry.parsedKind === 'npm'
            ? t('settings.plugins.sidebar.kind.npm')
            : t('settings.plugins.sidebar.kind.path')
        }
        selected={selectedId === entry.id}
        onSelect={() => handleSelect(entry.id)}
        icon={
          <Icon
            name={entryIcon(entry)}
            className="h-4 w-4 flex-shrink-0 text-muted-foreground/70"
          />
        }
        actions={actions}
      />
    );
  };

  const renderFile = (file: PluginFile) => (
    <SettingsSidebarItem
      key={file.id}
      title={file.fileName}
      metadata={t('settings.plugins.sidebar.kind.file')}
      selected={selectedId === file.id}
      onSelect={() => handleSelect(file.id)}
      icon={
        <Icon
          name="file-text"
          className="h-4 w-4 flex-shrink-0 text-muted-foreground/70"
        />
      }
      actions={[
        {
          label: t('settings.common.actions.delete'),
          icon: 'delete-bin',
          destructive: true,
          onClick: () =>
            setDeleteTarget({ kind: 'file', id: file.id, label: file.fileName }),
        },
      ]}
    />
  );

  const renderGroup = (
    label: string,
    children: React.ReactNode,
    updateCount = 0,
  ) => (
    <>
      <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        {updateCount > 0 && (
          <span className="ml-2 normal-case font-normal text-[var(--status-success)]">
            {t(
              updateCount === 1
                ? 'settings.plugins.sidebar.group.updatesAvailable_one'
                : 'settings.plugins.sidebar.group.updatesAvailable_other',
              { count: updateCount },
            )}
          </span>
        )}
      </div>
      {children}
    </>
  );

  return (
    <>
      <SettingsSidebarLayout
        variant="background"
        header={
          <div className="border-b px-3 pt-4 pb-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">
                {t('settings.plugins.sidebar.title')}
              </h2>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="typography-meta text-muted-foreground">
                {t('settings.plugins.sidebar.total', { count: total })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 -my-1 text-muted-foreground"
                  onClick={() => void handleRefresh()}
                  disabled={isLoadingRegistry}
                  aria-label={t('settings.plugins.sidebar.actions.refresh')}
                  title={t('settings.plugins.sidebar.actions.refresh')}
                >
                  <Icon
                    name="refresh"
                    className={
                      isLoadingRegistry ? 'size-4 animate-spin' : 'size-4'
                    }
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 -my-1 text-muted-foreground"
                  onClick={handleAdd}
                  aria-label={t('settings.plugins.sidebar.actions.addTitle')}
                  title={t('settings.plugins.sidebar.actions.addTitle')}
                >
                  <Icon name="add" className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        }
      >
        {isEmpty ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <Icon name="plug" className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">
              {t('settings.plugins.sidebar.empty.title')}
            </p>
            <p className="typography-meta mt-1 opacity-75">
              {t('settings.plugins.sidebar.empty.description')}
            </p>
          </div>
        ) : (
          <>
            {userEntries.length > 0 &&
              renderGroup(
                t('settings.plugins.sidebar.group.userEntries'),
                userEntries.map(renderEntry),
                updateCounts.userEntries,
              )}
            {userFiles.length > 0 &&
              renderGroup(
                t('settings.plugins.sidebar.group.userFiles'),
                userFiles.map(renderFile),
              )}
            {projectEntries.length > 0 &&
              renderGroup(
                t('settings.plugins.sidebar.group.projectEntries'),
                projectEntries.map(renderEntry),
                updateCounts.projectEntries,
              )}
            {projectFiles.length > 0 &&
              renderGroup(
                t('settings.plugins.sidebar.group.projectFiles'),
                projectFiles.map(renderFile),
              )}
          </>
        )}
      </SettingsSidebarLayout>

      <AddPluginDialog open={isAddOpen} onOpenChange={setIsAddOpen} />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('settings.plugins.sidebar.deleteDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.plugins.sidebar.deleteDialog.description', {
                name: deleteTarget?.label ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting
                ? t('settings.plugins.sidebar.actions.deleting')
                : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
