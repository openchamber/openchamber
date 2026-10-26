import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsBackButton,
  SettingsCard,
  SettingsCardChip,
  SettingsCardPill,
  type SettingsCardAction,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { Button } from '@/components/ui/button';
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
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getGuestSourceUrl } from '@/lib/guests/source-url';
import { approveGuestCapabilities, installGuest, setGuestEnabled, uninstallGuest, uploadGuestZip } from '@/lib/guests/install';
import { errorToastKey, updateErrorToastKey } from './extensionToasts';
import { closeGuestTabsById } from '@/lib/guests/tabs';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { describeGuestRequestFailure } from '@/lib/guests/request-failure';
import { getGitIdentities, getGlobalGitIdentity } from '@/lib/gitApi';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { GitIdentityProfile } from '@/stores/useGitIdentitiesStore';
import { IdentityDropdown } from '@/components/views/git/GitHeader';
import { checkGuestUpdates, updateGuest } from '@/lib/guests/updates';
import type { GuestSource, InstalledGuest, UnreadableGuest } from '@/lib/guests/types';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n, type I18nKey, type Locale } from '@/lib/i18n';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { canRequestNativeDirectoryAccess, pathForDroppedFile, requestDirectoryAccess, requestFileAccess } from '@/lib/desktop';
import type { PublicSocketBinding } from '@openchamber/sdk';


/**
 * What the user handed us to install: a typed path or URL (also what the
 * desktop resolves from a picker or a drop), or a `.zip` File the browser
 * holds that has to travel to the host.
 */
type InstallSource =
  | { kind: 'input'; input: string; gitIdentityId?: string }
  | { kind: 'file'; file: File };

const isZipFile = (file: File): boolean => file.name.toLowerCase().endsWith('.zip');

// Website locales that have their own extensions page; the rest read the English one.
const WEBSITE_LOCALE_PATHS = {
  uk: 'uk', 'zh-CN': 'zh', 'zh-TW': 'zh', es: 'es', 'pt-BR': 'pt', ko: 'ko',
  pl: 'pl', fr: 'fr', ja: 'ja', de: 'de', tr: 'tr', nl: 'nl',
  en: null, ar: null, he: null,
} as const satisfies Record<Locale, string | null>;

const communityExtensionsUrl = (locale: Locale): string => {
  const path = WEBSITE_LOCALE_PATHS[locale];
  return path ? `https://openchamber.dev/${path}/extensions/` : 'https://openchamber.dev/extensions/';
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

/** What a card and the detail screen say about an extension's state. */
const extensionState = (guest: InstalledGuest) => {
  const enabled = guest.enabled !== false;
  // Enterprise mode refuses what this package asks for; approving cannot change that.
  const enterpriseBlocked = (guest.enterpriseBlocked?.length ?? 0) > 0;
  const needsApproval = !enterpriseBlocked && guestNeedsApproval(guest);
  const builtIn = guest.source === 'bundled';
  const statusKey: I18nKey = enterpriseBlocked
    ? 'settings.extensions.status.enterpriseBlocked'
    : needsApproval
      ? 'settings.extensions.status.needsApproval'
      : enabled
        ? 'settings.extensions.status.enabled'
        : 'settings.extensions.status.disabled';
  const statusTone: SettingsCardTone = enterpriseBlocked || needsApproval ? 'warning' : enabled ? 'success' : 'neutral';
  return {
    enabled,
    enterpriseBlocked,
    needsApproval,
    builtIn,
    canRemove: Boolean(guest.source && guest.source !== 'bundled'),
    sourceUrl: getGuestSourceUrl(guest),
    // Only a git install can move forward; folder and zip installs never do.
    update: guest.source === 'git' ? guest.update : undefined,
    statusKey,
    statusTone,
  };
};

const useGuestIconSrc = (guest: InstalledGuest) => React.useMemo(
  () => guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset),
  [guest.id, guest.icon],
);

type ExtensionHandlers = {
  busy: boolean;
  onReview: (guest: InstalledGuest) => void;
  onRemove: (id: string, name: string) => Promise<void>;
  onSetEnabled: (id: string, name: string, enabled: boolean) => Promise<void>;
  onUpdate: (guest: InstalledGuest) => Promise<void>;
};

/** One extension in the grid: name, state, source; opens its detail screen. */
const ExtensionCard: React.FC<ExtensionHandlers & { guest: InstalledGuest; onOpen: () => void }> = ({
  guest,
  busy,
  onOpen,
  onReview,
  onRemove,
  onSetEnabled,
  onUpdate,
}) => {
  const { t } = useI18n();
  const state = extensionState(guest);
  const iconSrc = useGuestIconSrc(guest);
  const actions: SettingsCardAction[] = busy ? [] : [
    ...(state.update ? [{
      label: t('settings.extensions.update.action'),
      icon: 'arrow-up-s' as const,
      onSelect: () => void onUpdate(guest),
    }] : []),
    ...(state.needsApproval ? [{
      label: t('settings.extensions.review'),
      icon: 'shield-check' as const,
      onSelect: () => onReview(guest),
    }] : []),
    ...(state.enterpriseBlocked ? [] : [{
      label: state.enabled ? t('settings.extensions.actions.disable') : t('settings.extensions.actions.enable'),
      icon: state.enabled ? 'pause' as const : 'play' as const,
      onSelect: () => void onSetEnabled(guest.id, guest.name, !state.enabled),
    }]),
    ...(state.sourceUrl ? [{
      label: t('settings.extensions.actions.openSource'),
      icon: 'external-link' as const,
      onSelect: () => void openExternalUrl(state.sourceUrl ?? ''),
    }] : []),
    ...(state.canRemove ? [{
      label: t('settings.extensions.remove'),
      icon: 'delete-bin' as const,
      destructive: true,
      onSelect: () => void onRemove(guest.id, guest.name),
    }] : []),
  ];
  return (
    <SettingsCard
      icon={<GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={iconSrc} className="size-5 text-foreground" />}
      title={guest.name}
      badges={(
        <>
          {state.update ? (
            <SettingsCardPill tone="info">{t('settings.extensions.update.badge', { version: state.update.version })}</SettingsCardPill>
          ) : null}
          <SettingsCardPill tone={state.statusTone}>{t(state.statusKey)}</SettingsCardPill>
        </>
      )}
      footer={(
        <>
          <span className="truncate">{extensionMeta(guest, t)}</span>
          {state.builtIn ? <SettingsCardChip>{t('settings.extensions.source.bundled')}</SettingsCardChip> : null}
        </>
      )}
      muted={!state.enabled}
      onOpen={onOpen}
      actionsLabel={t('settings.extensions.grid.actionsAria', { name: guest.name })}
      actions={actions}
    />
  );
};

/** Source, version and "no panel" on one line; built-in shows no source. */
const extensionMeta = (guest: InstalledGuest, t: ReturnType<typeof useI18n>['t']): string => [
  guest.source === 'bundled' ? null : t(sourceKey(guest.source)),
  guest.version ? `v${guest.version}` : null,
  guest.entry ? null : t('settings.extensions.source.noPanel'),
].filter(Boolean).join(' · ');

/** One extension's screen: what needs doing, where it comes from, what it may do. */
const ExtensionDetail: React.FC<ExtensionHandlers & { guest: InstalledGuest; onBack: () => void }> = ({
  guest,
  busy,
  onBack,
  onReview,
  onRemove,
  onSetEnabled,
  onUpdate,
}) => {
  const { t } = useI18n();
  const state = extensionState(guest);
  const iconSrc = useGuestIconSrc(guest);
  const permissions = servicePermissionList(guest);
  const location = guest.path || guest.id;
  const hasPermissions = Boolean(permissions) || Boolean(guest.service);

  return (
    <SettingsPageLayout
      title={guest.name}
      titleLeading={(
        <>
          <SettingsBackButton label={t('settings.extensions.detail.back')} onClick={onBack} />
          <GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={iconSrc} className="size-5 shrink-0 text-foreground" />
        </>
      )}
      titleAccessory={<SettingsCardPill tone={state.statusTone}>{t(state.statusKey)}</SettingsCardPill>}
      headerEnd={(
        <div className="flex items-center gap-2">
          {state.enterpriseBlocked ? null : (
            <Button
              type="button"
              size="sm"
              variant={state.enabled ? 'outline' : 'default'}
              disabled={busy}
              aria-label={state.enabled
                ? t('settings.extensions.actions.disable.aria', { name: guest.name })
                : t('settings.extensions.actions.enable.aria', { name: guest.name })}
              onClick={() => void onSetEnabled(guest.id, guest.name, !state.enabled)}
            >
              {state.enabled ? t('settings.extensions.actions.disable') : t('settings.extensions.actions.enable')}
            </Button>
          )}
          {state.canRemove ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-[var(--status-error)] hover:text-[var(--status-error)]"
              disabled={busy}
              aria-label={t('settings.extensions.remove.aria', { name: guest.name })}
              onClick={() => void onRemove(guest.id, guest.name).then(onBack)}
            >
              <Icon name="delete-bin" className="size-3.5" />
              {t('settings.extensions.remove')}
            </Button>
          ) : null}
        </div>
      )}
    >
      {state.enterpriseBlocked || state.needsApproval || state.update ? (
        <SettingsSection divider={false} contentClassName="space-y-2">
          {state.enterpriseBlocked ? (
            <div className="rounded-lg bg-[var(--status-warning)]/10 p-3 typography-meta text-[var(--status-warning)]">
              {t('settings.extensions.enterpriseBlocked')}
            </div>
          ) : null}
          {state.needsApproval ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--status-warning)]/10 p-3">
              <span className="typography-meta text-[var(--status-warning)]">{t('settings.extensions.status.needsApproval')}</span>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                aria-label={t('settings.extensions.review.aria', { name: guest.name })}
                onClick={() => onReview(guest)}
              >
                {t('settings.extensions.review')}
              </Button>
            </div>
          ) : null}
          {state.update ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--status-info)]/10 p-3">
              <span className="typography-meta text-[var(--status-info)]">
                {t('settings.extensions.update.badge', { version: state.update.version })}
              </span>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                aria-label={t('settings.extensions.update.action.aria', { name: guest.name, version: state.update.version })}
                onClick={() => void onUpdate(guest)}
              >
                {t('settings.extensions.update.action')}
              </Button>
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t('settings.extensions.detail.section.details')}
        divider={state.enterpriseBlocked || state.needsApproval || Boolean(state.update)}
        contentClassName="space-y-3"
      >
        <div>
          <SettingsFieldRow label={t('settings.extensions.detail.field.source')}>
            <span className="typography-ui-label text-foreground">{t(sourceKey(guest.source))}</span>
            {state.sourceUrl ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void openExternalUrl(state.sourceUrl ?? '')}>
                <Icon name="external-link" className="size-3.5" />
                {t('settings.extensions.actions.openSource')}
              </Button>
            ) : null}
          </SettingsFieldRow>
          {guest.version ? (
            <SettingsFieldRow label={t('settings.extensions.detail.field.version')}>
              <span className="typography-ui-label tabular-nums text-foreground">{`v${guest.version}`}</span>
            </SettingsFieldRow>
          ) : null}
          <SettingsFieldRow label={t('settings.extensions.detail.field.location')} alignEnd={false} controlClassName="min-w-0 @xl:flex-1">
            <span className="typography-meta min-w-0 truncate font-mono text-muted-foreground" title={location}>{location}</span>
          </SettingsFieldRow>
        </div>
        {state.builtIn ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.extensions.builtIn.info')}</p> : null}
      </SettingsSection>

      {hasPermissions ? (
        <SettingsSection title={t('settings.extensions.detail.section.permissions')} contentClassName="space-y-3">
          {permissions ? (
            <p className="typography-meta text-foreground">{t('settings.extensions.service.permissions', { list: permissions })}</p>
          ) : null}
          {guest.service ? (
            // A security warning: stays visible.
            <p className="typography-meta text-[var(--status-warning)]">{t('settings.extensions.service.warning')}</p>
          ) : null}
          {state.enabled
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
        </SettingsSection>
      ) : null}
    </SettingsPageLayout>
  );
};

/**
 * An installed row this build could not read: it gets its name and, when the
 * server can identify it, a way to remove it. Its other fields are unknown.
 */
const UnreadableExtensionCard: React.FC<{
  guest: UnreadableGuest;
  busy: boolean;
  onRemove: (id: string, name: string) => Promise<void>;
}> = ({ guest, busy, onRemove }) => {
  const { t } = useI18n();
  const name = guest.name ?? guest.id ?? t('settings.extensions.unreadable.unnamed');
  const removableId = guest.builtIn ? null : guest.id;
  return (
    <SettingsCard
      icon={<Icon name="error-warning" className="size-5 text-[var(--status-error)]" />}
      title={name}
      badges={<SettingsCardPill tone="error">{t('settings.extensions.status.unreadable')}</SettingsCardPill>}
      // Removing is the one thing to do with it, so the button is on the card.
      footer={(
        <>
          <span className="min-w-0 flex-1 truncate" title={t('settings.extensions.unreadable.hint')}>{t('settings.extensions.unreadable.hint')}</span>
          {removableId ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0 !font-normal"
              disabled={busy}
              aria-label={t('settings.extensions.remove.aria', { name })}
              onClick={() => void onRemove(removableId, name)}
            >
              {t('settings.extensions.remove')}
            </Button>
          ) : null}
        </>
      )}
    />
  );
};

export const ExtensionsPage: React.FC = () => {
  const { t, locale } = useI18n();
  const guests = useGuestsStore((state) => state.guests);
  const unreadable = useGuestsStore((state) => state.unreadable);
  const status = useGuestsStore((state) => state.status);
  const catalogFailure = useGuestsStore((state) => state.failure);
  const runtimeKey = useGuestsStore((state) => state.runtimeKey);
  const [identityData, setIdentityData] = React.useState<{
    runtimeKey: string;
    profiles: GitIdentityProfile[];
    global: Awaited<ReturnType<typeof getGlobalGitIdentity>>;
  } | null>(null);
  const [identityLoadFailed, setIdentityLoadFailed] = React.useState(false);
  const [selectedGitIdentityId, setSelectedGitIdentityId] = React.useState('global');
  const unsupported = status === 'unsupported';
  const [installValue, setInstallValue] = React.useState('');
  const enterpriseMode = useEnterpriseMode();
  const [busy, setBusy] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const checkedOnOpen = React.useRef(false);
  const [reinstall, setReinstall] = React.useState<{ source: InstallSource; name: string } | null>(null);
  const [approval, setApproval] = React.useState<InstalledGuest | null>(null);
  const [dropActive, setDropActive] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  // The shown extension is page-local: every visit starts at the grid.
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const dragDepth = React.useRef(0);
  const zipInputRef = React.useRef<HTMLInputElement | null>(null);
  // Desktop on its own machine can hand the server a path; every other
  // runtime that shows this page (web, remote desktop instance) uploads.
  const nativePaths = canRequestNativeDirectoryAccess();

  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setIdentityData(null);
    setIdentityLoadFailed(false);
    setSelectedGitIdentityId('global');
    setReinstall(null);
    setApproval(null);
    checkedOnOpen.current = false;
    if (unsupported) return;
    void Promise.all([getGitIdentities(), getGlobalGitIdentity()]).then(([profiles, global]) => {
      if (!cancelled) setIdentityData({ runtimeKey, profiles, global });
    }).catch(() => {
      if (!cancelled) setIdentityLoadFailed(true);
    });
    return () => { cancelled = true; };
  }, [runtimeKey, unsupported]);

  const identities = React.useMemo<GitIdentityProfile[]>(() => {
    const data = identityData?.runtimeKey === runtimeKey ? identityData : null;
    return [{
      id: 'global', name: t('settings.gitIdentities.editor.title.globalIdentity'),
      userName: data?.global?.userName ?? '', userEmail: data?.global?.userEmail ?? '',
      icon: 'fingerprint', color: 'info',
    }, ...(data?.profiles.filter((profile) => profile.id !== 'global') ?? [])];
  }, [identityData, runtimeKey, t]);
  const selectedGitIdentity = identities.find((profile) => profile.id === selectedGitIdentityId) ?? identities[0];

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
    if (!result.ok && result.code === 'unreadable') {
      // The server installed it; the list shows it as a row that cannot load.
      setInstallValue('');
      setReinstall(null);
      toast.error(t(errorToastKey(result.code)));
      await loadGuestCatalog();
      return false;
    }
    if (!result.ok) {
      if (
        options.allowConflictDialog !== false
        && (result.code === 'id-taken' || result.code === 'already-installed')
      ) {
        const existing = result.id
          ? guests.find((guest) => guest.id === result.id) ?? unreadable.find((guest) => guest.id === result.id)
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
          { description: result.diagnostic ? describeGuestRequestFailure(result.diagnostic, t) : undefined },
        );
      } else {
        toast.error(t(errorToastKey(result.code)), {
          description: result.diagnostic ? describeGuestRequestFailure(result.diagnostic, t) : undefined,
        });
      }
      return false;
    }
    setInstallValue('');
    setReinstall(null);
    setAddOpen(false);
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
    const requestRuntimeKey = getRuntimeKey();
    if (source.kind === 'input') {
      setInstallValue(source.input);
    }
    setBusy(true);
    const result = source.kind === 'file'
      ? await uploadGuestZip(source.file, options)
      : await installGuest(source.input, { ...options, gitIdentityId: source.gitIdentityId });
    setBusy(false);
    if (getRuntimeKey() !== requestRuntimeKey) return;
    await finishInstall(result, source, { allowConflictDialog: !options.replace });
  };

  const add = async () => {
    const trimmed = installValue.trim();
    if (!trimmed) {
      toast.error(t('settings.extensions.toast.invalidPath'));
      return;
    }
    await runInstall({ kind: 'input', input: trimmed, gitIdentityId: selectedGitIdentity.id });
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

  const dropHandlers = {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void onDrop(event),
  };
  const handlers: ExtensionHandlers = {
    busy,
    onReview: setApproval,
    onRemove: remove,
    onSetEnabled: setEnabled,
    onUpdate: update,
  };
  const selectedGuest = selectedId ? guests.find((guest) => guest.id === selectedId) ?? null : null;

  const dialogs = (
    <>
      <Dialog open={addOpen} onOpenChange={(open) => { if (!busy) setAddOpen(open); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('settings.extensions.grid.addTitle')}</DialogTitle>
            <DialogDescription>
              {enterpriseMode ? (
                <>
                  <span className="block">{t('settings.extensions.add.enterpriseRule')}</span>
                  <span className="mt-2 block">{t('settings.extensions.add.info')}</span>
                </>
              ) : t('settings.extensions.add.info')}
            </DialogDescription>
          </DialogHeader>
          <div
            className={cn(
              'relative space-y-2 rounded-lg border border-dashed border-[color-mix(in_srgb,var(--foreground)_14%,transparent)] p-3 transition-colors',
              dropActive && 'border-primary bg-primary/5',
            )}
            {...dropHandlers}
          >
            {dropActive ? (
              <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/80 typography-ui-label text-primary">
                {t('settings.extensions.add.drop.active')}
              </span>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
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
                  className={cn('h-8 min-w-0 flex-1 rounded-md ps-3', nativePaths ? 'pe-14' : 'pe-8')}
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
                <div className="absolute inset-e-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
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
              <div className="shrink-0">
                <IdentityDropdown
                  activeProfile={selectedGitIdentity}
                  identities={identities}
                  onSelect={(profile) => setSelectedGitIdentityId(profile.id)}
                  isApplying={busy || (!identityData && !identityLoadFailed)}
                  iconOnly
                />
              </div>
            </div>
            <p className="typography-micro text-muted-foreground">
              {t(nativePaths ? 'settings.extensions.add.drop' : 'settings.extensions.add.drop.zipOnly')}
            </p>
            {identityLoadFailed ? <p className="typography-meta text-destructive">{t('settings.extensions.identity.loadFailed')}</p> : null}
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAddOpen(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" disabled={busy} aria-label={t('settings.extensions.add.aria')} onClick={() => void add()}>
              {busy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="add" className="h-4 w-4" />}
              {t('settings.extensions.add.action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </>
  );


  if (selectedGuest) {
    return (
      <>
        <ExtensionDetail guest={selectedGuest} onBack={() => setSelectedId(null)} {...handlers} />
        {dialogs}
      </>
    );
  }

  const hasItems = guests.length > 0 || unreadable.length > 0;

  return (
    <>
      <SettingsPageLayout
        title={t('settings.page.extensions.title')}
        description={t('settings.page.extensions.description')}
        headerEnd={unsupported ? null : (
          <div className="flex items-center gap-2">
            {/* Enterprise mode installs only from approved repositories, so the public list stays out of it. */}
            {enterpriseMode ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 gap-1.5"
                data-settings-item="extensions.browse"
                title={t('settings.extensions.browse.hint')}
                onClick={() => void openExternalUrl(communityExtensionsUrl(locale))}
              >
                <Icon name="compass-3" className="size-4" />
                {t('settings.extensions.browse.label')}
                <Icon name="external-link" className="size-3.5 text-muted-foreground" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-muted-foreground"
              data-settings-item="extensions.updates.check"
              disabled={busy || checking || status !== 'ready'}
              aria-label={t('settings.extensions.updates.check.aria')}
              title={t('settings.extensions.updates.check')}
              onClick={() => void checkForUpdates()}
            >
              <Icon name="refresh" className={cn('size-4', checking && 'animate-spin')} />
            </Button>
          </div>
        )}
      >
        {/* The whole grid takes a dropped folder or ZIP, not only the dialog. */}
        <div className="relative" {...(unsupported ? {} : dropHandlers)}>
          {dropActive && !addOpen ? (
            <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border border-dashed border-primary bg-background/80 typography-ui-label text-primary">
              {t('settings.extensions.add.drop.active')}
            </span>
          ) : null}

          {status === 'error' || catalogFailure ? (
            <p className="mb-4 typography-meta whitespace-pre-line text-destructive">
              {t('settings.extensions.toast.loadFailed')}
              {catalogFailure ? `\n${describeGuestRequestFailure(catalogFailure, t)}` : ''}
            </p>
          ) : null}
          {unsupported ? (
            <p className="typography-meta text-muted-foreground">{t('settings.extensions.unsupported')}</p>
          ) : (
            <div className={SETTINGS_CARD_GRID_CLASS}>
              <SettingsAddCard
                label={t('settings.extensions.grid.addTitle')}
                hint={t('settings.extensions.grid.addHint')}
                onClick={() => setAddOpen(true)}
                settingsItem="extensions.add"
              />
              {guests.map((guest) => (
                <ExtensionCard key={guest.id} guest={guest} onOpen={() => setSelectedId(guest.id)} {...handlers} />
              ))}
              {unreadable.map((guest, index) => (
                <UnreadableExtensionCard
                  key={guest.id ?? `unreadable-${index}`}
                  guest={guest}
                  busy={busy}
                  onRemove={remove}
                />
              ))}
            </div>
          )}
          {status === 'ready' && !hasItems && !unsupported ? (
            <p className="pt-4 typography-meta text-muted-foreground">{t('settings.extensions.empty')}</p>
          ) : null}
        </div>
      </SettingsPageLayout>
      {dialogs}
    </>
  );
};
