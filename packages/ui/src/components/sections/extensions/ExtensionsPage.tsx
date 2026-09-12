import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_ICON_BUTTON_CLASS,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { GuestApprovalDialog } from './GuestApprovalDialog';
import { toast } from '@/components/ui';
import { setGuestServiceSocketPath } from '@/lib/guests/service';
import { guestNeedsApproval } from '@/lib/guests/capabilities';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { approveGuestCapabilities, installGuest, setGuestEnabled, uninstallGuest, uploadGuestZip, type InstallGuestErrorCode } from '@/lib/guests/install';
import { closeGuestTabsById } from '@/lib/guests/tabs';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { checkGuestUpdates, updateGuest, type UpdateGuestErrorCode } from '@/lib/guests/updates';
import type { GuestSource, InstalledGuest } from '@/lib/guests/types';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { cn } from '@/lib/utils';
import { canRequestNativeDirectoryAccess, pathForDroppedFile, requestDirectoryAccess, requestFileAccess } from '@/lib/desktop';
import type { PublicSocketBinding } from '@openchamber/sdk';

const errorToastKey = (code: InstallGuestErrorCode): I18nKey => {
  if (code === 'invalid-path') return 'settings.extensions.toast.invalidPath';
  if (code === 'invalid-url') return 'settings.extensions.toast.invalidUrl';
  if (code === 'not-found') return 'settings.extensions.toast.notFound';
  if (code === 'invalid-manifest') return 'settings.extensions.toast.invalidManifest';
  if (code === 'id-taken') return 'settings.extensions.toast.idTaken';
  if (code === 'already-installed') return 'settings.extensions.toast.alreadyInstalled';
  if (code === 'missing-build') return 'settings.extensions.toast.missingBuild';
  if (code === 'host-too-old') return 'settings.extensions.toast.hostTooOld';
  if (code === 'clone-failed') return 'settings.extensions.toast.cloneFailed';
  if (code === 'extract-failed') return 'settings.extensions.toast.extractFailed';
  if (code === 'too-large') return 'settings.extensions.toast.zipTooLarge';
  return 'settings.extensions.toast.failed';
};

/**
 * What the user handed us to install: a typed path or URL (also what the
 * desktop resolves from a picker or a drop), or a `.zip` File the browser
 * holds that has to travel to the host.
 */
type InstallSource =
  | { kind: 'input'; input: string }
  | { kind: 'file'; file: File };

const isZipFile = (file: File): boolean => file.name.toLowerCase().endsWith('.zip');

const updateErrorToastKey = (code: UpdateGuestErrorCode): I18nKey => {
  if (code === 'not-git') return 'settings.extensions.toast.notGit';
  if (code === 'clone-failed') return 'settings.extensions.toast.cloneFailed';
  if (code === 'invalid-manifest') return 'settings.extensions.toast.invalidManifest';
  if (code === 'missing-build') return 'settings.extensions.toast.missingBuild';
  if (code === 'swap-failed') return 'settings.extensions.toast.swapFailed';
  if (code === 'not-found') return 'settings.extensions.toast.notFound';
  return 'settings.extensions.toast.updateFailed';
};

const sourceKey = (source?: GuestSource): I18nKey => {
  if (source === 'path') return 'settings.extensions.source.path';
  if (source === 'zip') return 'settings.extensions.source.zip';
  if (source === 'git') return 'settings.extensions.source.git';
  return 'settings.extensions.source.bundled';
};


const servicePermissionList = (guest: InstalledGuest): string => {
  const socketParts = (guest.service?.socketBindings ?? []).map((binding) => (
    binding.resolved ? `${binding.id}=${binding.resolved}` : `${binding.id}?`
  ));
  const legacySockets = (guest.service?.permissions?.sockets ?? []).filter((id) => (
    !(guest.service?.socketBindings ?? []).some((binding) => binding.id === id)
  ));
  const parts = [
    ...socketParts,
    ...legacySockets,
    ...(guest.service?.permissions?.exec ?? []),
  ];
  return parts.join(', ');
};

const SocketOverrideRow: React.FC<{
  guest: InstalledGuest;
  binding: PublicSocketBinding;
  busy: boolean;
  onSaved: () => Promise<void>;
}> = ({ guest, binding, busy, onSaved }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(binding.override ?? binding.resolved ?? '');
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState(!binding.resolved);

  React.useEffect(() => {
    setValue(binding.override ?? binding.resolved ?? '');
    if (!binding.resolved) {
      setEditing(true);
    }
  }, [binding.id, binding.override, binding.resolved]);

  const save = async (next: string | null) => {
    setSaving(true);
    const ok = await setGuestServiceSocketPath(guest.id, binding.id, next);
    setSaving(false);
    if (!ok) {
      toast.error(t('settings.extensions.toast.socketSaveFailed'));
      return;
    }
    toast.success(t('settings.extensions.toast.socketSaved', { name: guest.name }));
    setEditing(false);
    await onSaved();
  };

  const cancel = () => {
    setValue(binding.override ?? binding.resolved ?? '');
    if (binding.resolved) {
      setEditing(false);
    }
  };

  return (
    <div className="space-y-1">
      {editing ? (
        <div className="flex min-w-0 items-center gap-1">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t('settings.extensions.service.socket.path', { id: binding.id })}
            aria-label={t('settings.extensions.service.socket.path.aria', { id: binding.id })}
            className="h-8 min-w-0 flex-1 rounded-md px-3"
            disabled={busy || saving}
            autoFocus
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy || saving}
            aria-label={t('settings.extensions.service.socket.save.aria', { id: binding.id })}
            onClick={() => void save(value.trim() || null)}
          >
            {t('settings.extensions.service.socket.save')}
          </Button>
          {binding.override ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || saving}
              aria-label={t('settings.extensions.service.socket.clear.aria', { id: binding.id })}
              onClick={() => void save(null)}
            >
              {t('settings.extensions.service.socket.clear')}
            </Button>
          ) : null}
          {binding.resolved ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || saving}
              aria-label={t('settings.extensions.service.socket.cancel.aria', { id: binding.id })}
              onClick={cancel}
            >
              {t('settings.extensions.service.socket.cancel')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <div className="typography-meta min-w-0 flex-1 truncate text-muted-foreground">
            {binding.resolved
              ? t('settings.extensions.service.socket.resolved', { path: binding.resolved })
              : t('settings.extensions.service.socket.unresolved')}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={SETTINGS_ICON_BUTTON_CLASS}
            disabled={busy || saving}
            aria-label={t('settings.extensions.service.socket.edit.aria', { id: binding.id })}
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil" className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
};

type ExtensionCardProps = {
  guest: InstalledGuest;
  busy: boolean;
  onReview: (guest: InstalledGuest) => void;
  onRemove: (id: string, name: string) => Promise<void>;
  onSetEnabled: (id: string, name: string, enabled: boolean) => Promise<void>;
  onUpdate: (guest: InstalledGuest) => Promise<void>;
};

const ExtensionCard: React.FC<ExtensionCardProps> = ({
  guest,
  busy,
  onReview,
  onRemove,
  onSetEnabled,
  onUpdate,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const enabled = guest.enabled !== false;
  const needsApproval = guestNeedsApproval(guest);
  const permissions = servicePermissionList(guest);
  const canRemove = Boolean(guest.source && guest.source !== 'bundled');
  // Only a git install can move forward; folder and zip cards never get this.
  const update = guest.source === 'git' ? guest.update : undefined;
  const iconSrc = React.useMemo(
    () => guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset),
    [guest.id, guest.icon],
  );
  // The path is one unbreakable word; it lives in the expanded body so the
  // header line never clamps right after the version.
  const meta = [t(sourceKey(guest.source)), guest.version ? `v${guest.version}` : null].filter(Boolean).join(' · ');
  const location = guest.path || guest.id;
  const statusLabel = needsApproval
    ? t('settings.extensions.status.needsApproval')
    : enabled
      ? t('settings.extensions.status.enabled')
      : t('settings.extensions.status.disabled');
  const statusClassName = needsApproval
    ? 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]'
    : enabled
      ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
      : 'bg-[var(--surface-muted)] text-muted-foreground';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]">
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <GuestIcon
              icon={resolveGuestIconName(guest.icon)}
              iconSrc={iconSrc}
              className="size-5 text-foreground"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{guest.name}</div>
            <p className="mt-0.5 truncate text-xs leading-snug text-muted-foreground">
              {meta}
            </p>
          </div>
          {update ? (
            <span className="max-w-40 shrink-0 truncate rounded-full bg-[var(--status-info)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--status-info)]">
              {t('settings.extensions.update.badge', { version: update.version })}
            </span>
          ) : null}
          <span
            aria-live="polite"
            className={cn('max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium', statusClassName)}
          >
            {statusLabel}
          </span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
          <div className="space-y-3">
            <p className="typography-meta truncate font-mono text-muted-foreground" title={location}>
              {location}
            </p>
            {permissions ? (
              <p className="typography-meta truncate text-muted-foreground">
                {t('settings.extensions.service.permissions', { list: permissions })}
              </p>
            ) : null}
            {guest.service ? (
              <p className="typography-meta text-muted-foreground">
                {t('settings.extensions.service.warning')}
              </p>
            ) : null}
            {enabled
              ? (guest.service?.socketBindings ?? []).map((binding) => (
                <SocketOverrideRow
                  key={binding.id}
                  guest={guest}
                  binding={binding}
                  busy={busy}
                  onSaved={loadGuestCatalog}
                />
              ))
              : null}
            <div className="flex flex-wrap items-center gap-2">
              {update ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label={t('settings.extensions.update.action.aria', { name: guest.name, version: update.version })}
                  onClick={() => void onUpdate(guest)}
                >
                  {t('settings.extensions.update.action')}
                </Button>
              ) : null}
              {needsApproval ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label={t('settings.extensions.review.aria', { name: guest.name })}
                  onClick={() => onReview(guest)}
                >
                  {t('settings.extensions.review')}
                </Button>
              ) : null}
              {enabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-label={t('settings.extensions.actions.disable.aria', { name: guest.name })}
                  onClick={() => void onSetEnabled(guest.id, guest.name, false)}
                >
                  {t('settings.extensions.actions.disable')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label={t('settings.extensions.actions.enable.aria', { name: guest.name })}
                  onClick={() => void onSetEnabled(guest.id, guest.name, true)}
                >
                  {t('settings.extensions.actions.enable')}
                </Button>
              )}
              {canRemove ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  aria-label={t('settings.extensions.remove.aria', { name: guest.name })}
                  onClick={() => void onRemove(guest.id, guest.name)}
                >
                  {t('settings.extensions.remove')}
                </Button>
              ) : null}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

export const ExtensionsPage: React.FC = () => {
  const { t } = useI18n();
  const guests = useGuestsStore((state) => state.guests);
  const status = useGuestsStore((state) => state.status);
  const unsupported = status === 'unsupported';
  const [installValue, setInstallValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const checkedOnOpen = React.useRef(false);
  const [reinstall, setReinstall] = React.useState<{ source: InstallSource; name: string } | null>(null);
  const [approval, setApproval] = React.useState<InstalledGuest | null>(null);
  const [dropActive, setDropActive] = React.useState(false);
  const dragDepth = React.useRef(0);
  const zipInputRef = React.useRef<HTMLInputElement | null>(null);
  // Desktop on its own machine can hand the server a path; every other
  // runtime that shows this page (web, remote desktop instance) uploads.
  const nativePaths = canRequestNativeDirectoryAccess();

  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);

  // One quiet check per page open, once the catalog is in. The server
  // answers from its hour cache, so this is cheap on a revisit.
  React.useEffect(() => {
    if (status !== 'ready' || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    const runtimeKey = useGuestsStore.getState().runtimeKey;
    void checkGuestUpdates(false).then((result) => {
      if (result.ok) {
        useGuestsStore.getState().applyUpdates(result.updates, runtimeKey);
      }
    });
  }, [status]);

  const checkForUpdates = async () => {
    setChecking(true);
    const runtimeKey = useGuestsStore.getState().runtimeKey;
    const result = await checkGuestUpdates(true);
    setChecking(false);
    if (!result.ok) {
      toast.error(t('settings.extensions.toast.checkFailed'));
      return;
    }
    useGuestsStore.getState().applyUpdates(result.updates, runtimeKey);
    if (Object.keys(result.updates).length === 0) {
      toast.success(t('settings.extensions.toast.upToDate'));
    }
  };

  const update = async (guest: InstalledGuest) => {
    setBusy(true);
    const result = await updateGuest(guest.id);
    setBusy(false);
    if (!result.ok) {
      toast.error(
        result.code === 'host-too-old' && result.required
          ? t('settings.extensions.toast.hostTooOld', { version: result.required })
          : t(updateErrorToastKey(result.code)),
      );
      return;
    }
    // Open panels still run the old bundle; the next open loads the new one.
    closeGuestTabsById(guest.id);
    toast.success(t('settings.extensions.toast.updated', {
      name: result.guest.name,
      version: result.guest.version ?? '',
    }));
    await loadGuestCatalog();
    // A version that asks for more than the user approved goes through the
    // same review dialog an install does.
    if (guestNeedsApproval(result.guest)) {
      setApproval(result.guest);
    }
  };

  const finishInstall = async (
    result: Awaited<ReturnType<typeof installGuest>>,
    source: InstallSource,
    options: { allowConflictDialog?: boolean } = {},
  ): Promise<boolean> => {
    if (!result.ok) {
      if (
        options.allowConflictDialog !== false
        && (result.code === 'id-taken' || result.code === 'already-installed')
      ) {
        const existing = result.id
          ? guests.find((guest) => guest.id === result.id)
          : undefined;
        setReinstall({
          source,
          name: existing?.name ?? result.id ?? (source.kind === 'file' ? source.file.name : source.input),
        });
        return false;
      }
      if (result.code === 'host-too-old') {
        toast.error(
          result.required
            ? t('settings.extensions.toast.hostTooOld', { version: result.required })
            : t('settings.extensions.toast.failed'),
        );
      } else {
        toast.error(t(errorToastKey(result.code)));
      }
      return false;
    }
    setInstallValue('');
    setReinstall(null);
    toast.success(
      result.replaced
        ? t('settings.extensions.toast.reinstalled', { name: result.guest.name })
        : t('settings.extensions.toast.added', { name: result.guest.name }),
    );
    await loadGuestCatalog();
    if (guestNeedsApproval(result.guest)) {
      setApproval(result.guest);
    }
    return true;
  };

  const runInstall = async (source: InstallSource, options: { replace?: boolean } = {}) => {
    if (source.kind === 'input') {
      setInstallValue(source.input);
    }
    setBusy(true);
    const result = source.kind === 'file'
      ? await uploadGuestZip(source.file, options)
      : await installGuest(source.input, options);
    setBusy(false);
    await finishInstall(result, source, { allowConflictDialog: !options.replace });
  };

  const add = async () => {
    const trimmed = installValue.trim();
    if (!trimmed) {
      toast.error(t('settings.extensions.toast.invalidPath'));
      return;
    }
    await runInstall({ kind: 'input', input: trimmed });
  };

  const browseFolder = async () => {
    if (!nativePaths) return;
    const res = await requestDirectoryAccess('');
    if (res.success && res.path) {
      await runInstall({ kind: 'input', input: res.path });
    }
  };

  const browseZip = async () => {
    if (!nativePaths) {
      zipInputRef.current?.click();
      return;
    }
    const fileRes = await requestFileAccess({
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (fileRes.success && fileRes.path) {
      await runInstall({ kind: 'input', input: fileRes.path });
    }
  };

  const onZipPicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Clear so picking the same file again (after a failed try) fires change.
    event.target.value = '';
    if (!file) return;
    if (!isZipFile(file)) {
      toast.error(t('settings.extensions.toast.invalidPath'));
      return;
    }
    await runInstall({ kind: 'file', file });
  };

  const onDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (busy) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDropActive(true);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (busy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  };

  const onDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    // Without this the shell (or the browser) navigates to the dropped file.
    event.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    if (busy) return;
    const item = event.dataTransfer.items[0];
    const file = item?.getAsFile() ?? null;
    const entry = item?.webkitGetAsEntry() ?? null;
    const isDirectory = entry?.isDirectory === true;
    const isZip = file !== null && !isDirectory && isZipFile(file);
    // Fastest route: the desktop on its own machine names the path and the
    // server reads it; nothing travels over the wire.
    const path = file && nativePaths ? pathForDroppedFile(file) : null;
    if (path && (isDirectory || isZip)) {
      await runInstall({ kind: 'input', input: path });
      return;
    }
    if (isDirectory) {
      toast.error(t(nativePaths ? 'settings.extensions.toast.invalidPath' : 'settings.extensions.toast.folderNeedsZip'));
      return;
    }
    if (!file || !isZip) {
      toast.error(t('settings.extensions.toast.invalidPath'));
      return;
    }
    await runInstall({ kind: 'file', file });
  };

  const confirmReinstall = async () => {
    if (!reinstall) {
      return;
    }
    await runInstall(reinstall.source, { replace: true });
  };

  const remove = async (id: string, name: string) => {
    setBusy(true);
    const result = await uninstallGuest(id);
    setBusy(false);
    if (!result.ok) {
      toast.error(t('settings.extensions.toast.removeFailed'));
      return;
    }
    closeGuestTabsById(id);
    toast.success(t('settings.extensions.toast.removed', { name }));
    await loadGuestCatalog();
  };

  const approve = async (guest: InstalledGuest) => {
    setBusy(true);
    const ok = await approveGuestCapabilities(guest.id, guest.capabilities.requested);
    setBusy(false);
    if (!ok) {
      toast.error(t('settings.extensions.toast.approveFailed'));
      return;
    }
    setApproval(null);
    toast.success(t('settings.extensions.toast.approved', { name: guest.name }));
    await loadGuestCatalog();
  };

  // Declining at install is the same as never installing: the package goes.
  const decline = async (guest: InstalledGuest) => {
    setApproval(null);
    await remove(guest.id, guest.name);
  };

  const setEnabled = async (id: string, name: string, enabled: boolean) => {
    setBusy(true);
    const ok = await setGuestEnabled(id, enabled);
    setBusy(false);
    if (!ok) {
      toast.error(t('settings.extensions.toast.enabledFailed'));
      return;
    }
    if (!enabled) {
      closeGuestTabsById(id);
    }
    toast.success(
      enabled
        ? t('settings.extensions.toast.enabled', { name })
        : t('settings.extensions.toast.disabled', { name }),
    );
    await loadGuestCatalog();
  };

  return (
    <SettingsPageLayout
      title={t('settings.page.extensions.title')}
      description={t('settings.page.extensions.description')}
    >
      <SettingsSection
        title={t('settings.extensions.section.installed')}
        divider={false}
        contentClassName="space-y-3"
        headerAction={unsupported ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-settings-item="extensions.updates.check"
            disabled={busy || checking || status !== 'ready'}
            aria-label={t('settings.extensions.updates.check.aria')}
            onClick={() => void checkForUpdates()}
          >
            <Icon name="refresh" className={cn('h-4 w-4', checking && 'animate-spin')} />
            {t('settings.extensions.updates.check')}
          </Button>
        )}
      >
        {status === 'error' ? (
          <p className="typography-meta text-destructive">{t('settings.extensions.toast.loadFailed')}</p>
        ) : null}
        {unsupported ? (
          <p className="typography-meta text-muted-foreground">{t('settings.extensions.unsupported')}</p>
        ) : null}
        {status === 'ready' && guests.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('settings.extensions.empty')}</p>
        ) : null}
        {guests.map((guest) => (
          <ExtensionCard
            key={guest.id}
            guest={guest}
            busy={busy}
            onReview={setApproval}
            onRemove={remove}
            onSetEnabled={setEnabled}
            onUpdate={update}
          />
        ))}
      </SettingsSection>

      {unsupported ? null : (
        <SettingsSection
          title={t('settings.extensions.add.action')}
          info={t('settings.extensions.add.info')}
        >
          <SettingsStackedField
            label={t('settings.extensions.add.label')}
            info={t(nativePaths ? 'settings.extensions.add.drop' : 'settings.extensions.add.drop.zipOnly')}
            settingsItem="extensions.add"
            controlClassName="w-full max-w-none"
          >
            <div
              className={cn(
                'relative -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-md border border-dashed border-transparent p-1 transition-colors',
                dropActive && 'border-primary bg-primary/5',
              )}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={(event) => void onDrop(event)}
            >
              {dropActive ? (
                <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/80 typography-ui-label text-primary">
                  {t('settings.extensions.add.drop.active')}
                </span>
              ) : null}
              <div className="relative flex min-w-0 flex-1 items-center">
                <Input
                  value={installValue}
                  onChange={(event) => setInstallValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void add();
                    }
                  }}
                  placeholder={t('settings.extensions.add.placeholder')}
                  aria-label={t('settings.extensions.add.label')}
                  className={cn(
                    'h-8 min-w-0 flex-1 rounded-md pl-3',
                    nativePaths ? 'pr-14' : 'pr-8',
                  )}
                  disabled={busy}
                />
                <input
                  ref={zipInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => void onZipPicked(event)}
                />
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                  {nativePaths ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      title={t('settings.extensions.add.browseFolder')}
                      aria-label={t('settings.extensions.add.browseFolder.aria')}
                      disabled={busy}
                      onClick={() => void browseFolder()}
                    >
                      <Icon name="folder" className="h-4 w-4" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    title={t('settings.extensions.add.browseZip')}
                    aria-label={t('settings.extensions.add.browseZip.aria')}
                    disabled={busy}
                    onClick={() => void browseZip()}
                  >
                    <Icon name="archive" className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                aria-label={t('settings.extensions.add.aria')}
                onClick={() => void add()}
              >
                <Icon name="add" className="h-4 w-4" />
                {t('settings.extensions.add.action')}
              </Button>
            </div>
          </SettingsStackedField>
        </SettingsSection>
      )}

      <GuestApprovalDialog
        guest={approval}
        busy={busy}
        onApprove={(guest) => void approve(guest)}
        onDecline={(guest) => void decline(guest)}
        onDismiss={() => setApproval(null)}
      />

      <Dialog
        open={reinstall !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setReinstall(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.extensions.dialog.reinstallTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.extensions.dialog.reinstallDescription', {
                name: reinstall?.name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setReinstall(null)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void confirmReinstall()}
            >
              {t('settings.extensions.dialog.reinstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
