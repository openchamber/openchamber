import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { grantGuestAgent } from '@/lib/guests/agent';
import { installGuest, uninstallGuest, type InstallGuestErrorCode } from '@/lib/guests/install';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import type { GuestSource, InstalledGuest } from '@/lib/guests/types';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n, type I18nKey } from '@/lib/i18n';

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
  const parts = [
    ...(guest.agent?.permissions?.sockets ?? []),
    ...(guest.agent?.permissions?.exec ?? []),
  ];
  return parts.join(', ');
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

  return (
    <SettingsPageLayout
      title={t('settings.page.extensions.title')}
      description={t('settings.page.extensions.description')}
    >
      <SettingsSection title={t('settings.extensions.section.installed')} divider={false}>
        {status === 'error' ? (
          <p className="typography-meta text-destructive">{t('settings.extensions.toast.loadFailed')}</p>
        ) : null}
        {unsupported ? (
          <p className="typography-meta text-muted-foreground">{t('settings.extensions.unsupported')}</p>
        ) : null}
        {status === 'ready' && guests.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('settings.extensions.empty')}</p>
        ) : null}
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          {guests.map((guest) => (
            <div key={guest.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground">{guest.name}</div>
                <div className="typography-meta truncate text-muted-foreground">
                  {t(sourceKey(guest.source))}
                  {guest.path ? ` · ${guest.path}` : ` · ${guest.id}`}
                </div>
                {guest.agent?.granted ? (
                  <div className="typography-meta text-muted-foreground">
                    {t('settings.extensions.agent.allowed')}
                  </div>
                ) : null}
                {agentNeedsGrant(guest) ? (
                  <div className="typography-meta truncate text-muted-foreground">
                    {t('settings.extensions.agent.permissions', { list: agentPermissionList(guest) })}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {agentNeedsGrant(guest) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    aria-label={t('settings.extensions.agent.allow.aria', { name: guest.name })}
                    onClick={() => void allowAgent(guest.id, guest.name)}
                  >
                    {t('settings.extensions.agent.allow')}
                  </Button>
                ) : null}
                {guest.source && guest.source !== 'bundled' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    aria-label={t('settings.extensions.remove.aria', { name: guest.name })}
                    onClick={() => void remove(guest.id, guest.name)}
                  >
                    {t('settings.extensions.remove')}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
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
