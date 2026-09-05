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
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { grantGuestAgent, setGuestAgentSocketPath } from '@/lib/guests/agent';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { installGuest, setGuestEnabled, uninstallGuest, type InstallGuestErrorCode } from '@/lib/guests/install';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import type { GuestSource, InstalledGuest } from '@/lib/guests/types';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
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
  return 'settings.extensions.toast.failed';
};

const sourceKey = (source?: GuestSource): I18nKey => {
  if (source === 'path') return 'settings.extensions.source.path';
  if (source === 'zip') return 'settings.extensions.source.zip';
  if (source === 'git') return 'settings.extensions.source.git';
  return 'settings.extensions.source.bundled';
};

const agentNeedsGrant = (guest: InstalledGuest): boolean => {
  const agent = guest.agent;
  if (!agent || agent.granted) {
    return false;
  }
  const sockets = agent.permissions?.sockets?.length ?? 0;
  const exec = agent.permissions?.exec?.length ?? 0;
  return sockets > 0 || exec > 0;
};

const agentPermissionList = (guest: InstalledGuest): string => {
  const socketParts = (guest.agent?.socketBindings ?? []).map((binding) => (
    binding.resolved ? `${binding.id}=${binding.resolved}` : `${binding.id}?`
  ));
  const legacySockets = (guest.agent?.permissions?.sockets ?? []).filter((id) => (
    !(guest.agent?.socketBindings ?? []).some((binding) => binding.id === id)
  ));
  const parts = [
    ...socketParts,
    ...legacySockets,
    ...(guest.agent?.permissions?.exec ?? []),
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
    const ok = await setGuestAgentSocketPath(guest.id, binding.id, next);
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
            placeholder={t('settings.extensions.agent.socket.path', { id: binding.id })}
            aria-label={t('settings.extensions.agent.socket.path.aria', { id: binding.id })}
            className="h-8 min-w-0 flex-1 rounded-md px-3"
            disabled={busy || saving}
            autoFocus
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy || saving}
            aria-label={t('settings.extensions.agent.socket.save.aria', { id: binding.id })}
            onClick={() => void save(value.trim() || null)}
          >
            {t('settings.extensions.agent.socket.save')}
          </Button>
          {binding.override ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || saving}
              aria-label={t('settings.extensions.agent.socket.clear.aria', { id: binding.id })}
              onClick={() => void save(null)}
            >
              {t('settings.extensions.agent.socket.clear')}
            </Button>
          ) : null}
          {binding.resolved ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || saving}
              aria-label={t('settings.extensions.agent.socket.cancel.aria', { id: binding.id })}
              onClick={cancel}
            >
              {t('settings.extensions.agent.socket.cancel')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <div className="typography-meta min-w-0 flex-1 truncate text-muted-foreground">
            {binding.resolved
              ? t('settings.extensions.agent.socket.resolved', { path: binding.resolved })
              : t('settings.extensions.agent.socket.unresolved')}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={SETTINGS_ICON_BUTTON_CLASS}
            disabled={busy || saving}
            aria-label={t('settings.extensions.agent.socket.edit.aria', { id: binding.id })}
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
  onAllowAgent: (id: string, name: string) => Promise<void>;
  onRemove: (id: string, name: string) => Promise<void>;
  onSetEnabled: (id: string, name: string, enabled: boolean) => Promise<void>;
};

const ExtensionCard: React.FC<ExtensionCardProps> = ({
  guest,
  busy,
  onAllowAgent,
  onRemove,
  onSetEnabled,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const enabled = guest.enabled !== false;
  const needsGrant = agentNeedsGrant(guest);
  const permissions = agentPermissionList(guest);
  const canRemove = Boolean(guest.source && guest.source !== 'bundled');
  const iconSrc = React.useMemo(
    () => guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset),
    [guest.id, guest.icon],
  );
  const metaParts = [
    t(sourceKey(guest.source)),
    guest.version ? `v${guest.version}` : null,
    guest.path || guest.id,
  ].filter(Boolean);
  const meta = metaParts.join(' · ');
  const statusLabel = enabled
    ? t('settings.extensions.status.enabled')
    : t('settings.extensions.status.disabled');
  const statusClassName = enabled
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
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {meta}
            </p>
          </div>
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
            {guest.agent?.granted ? (
              <p className="typography-meta text-muted-foreground">
                {t('settings.extensions.agent.allowed')}
              </p>
            ) : null}
            {permissions ? (
              <p className="typography-meta truncate text-muted-foreground">
                {t('settings.extensions.agent.permissions', { list: permissions })}
              </p>
            ) : null}
            {enabled
              ? (guest.agent?.socketBindings ?? []).map((binding) => (
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
              {enabled && needsGrant ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label={t('settings.extensions.agent.allow.aria', { name: guest.name })}
                  onClick={() => void onAllowAgent(guest.id, guest.name)}
                >
                  {t('settings.extensions.agent.allow')}
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

  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);

  const add = async () => {
    const trimmed = installValue.trim();
    if (!trimmed) {
      toast.error(t('settings.extensions.toast.invalidPath'));
      return;
    }
    setBusy(true);
    const result = await installGuest(trimmed);
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'host-too-old') {
        toast.error(
          result.required
            ? t('settings.extensions.toast.hostTooOld', { version: result.required })
            : t('settings.extensions.toast.failed'),
        );
      } else {
        toast.error(t(errorToastKey(result.code)));
      }
      return;
    }
    setInstallValue('');
    toast.success(t('settings.extensions.toast.added', { name: result.guest.name }));
    await loadGuestCatalog();
  };

  const remove = async (id: string, name: string) => {
    setBusy(true);
    const result = await uninstallGuest(id);
    setBusy(false);
    if (!result.ok) {
      toast.error(t('settings.extensions.toast.removeFailed'));
      return;
    }
    toast.success(t('settings.extensions.toast.removed', { name }));
    await loadGuestCatalog();
  };

  const allowAgent = async (id: string, name: string) => {
    setBusy(true);
    const ok = await grantGuestAgent(id);
    setBusy(false);
    if (!ok) {
      toast.error(t('settings.extensions.toast.agentGrantFailed'));
      return;
    }
    toast.success(t('settings.extensions.toast.agentGranted', { name }));
    await loadGuestCatalog();
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
      const mode = pluginModeFromId(id);
      const ui = useUIStore.getState();
      for (const [directory, panel] of Object.entries(ui.contextPanelByDirectory)) {
        const tabIds = panel.tabs
          .filter((tab) => tab.mode === mode)
          .map((tab) => tab.id);
        if (tabIds.length > 0) {
          ui.closeContextPanelTabs(directory, tabIds);
        }
      }
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
            onAllowAgent={allowAgent}
            onRemove={remove}
            onSetEnabled={setEnabled}
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
            settingsItem="extensions.add"
            controlClassName="w-full max-w-none"
          >
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
              className="h-8 min-w-0 flex-1 rounded-md px-3"
              disabled={busy}
            />
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
          </SettingsStackedField>
        </SettingsSection>
      )}
    </SettingsPageLayout>
  );
};
