import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { isFullFolderPath } from '@/lib/guests/folders';
import { setGuestFolders } from '@/lib/guests/install';
import { reloadGuestCatalog } from '@/lib/guests/load-catalog';
import type { InstalledGuest } from '@/lib/guests/types';
import { useI18n } from '@/lib/i18n';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

const FOLDER_PLACEHOLDER = '~/projects/work';

type FoldersFieldProps = {
  folders: readonly string[];
  disabled?: boolean;
  onChange: (folders: string[]) => void;
};

type HeldDraftProps = { draft: string; onDraftChange: (draft: string) => void };

const ExtensionFoldersField: React.FC<FoldersFieldProps & Partial<HeldDraftProps>> = ({ folders, disabled = false, onChange, draft: heldDraft, onDraftChange }) => {
  const { t } = useI18n();
  const [ownDraft, setOwnDraft] = React.useState('');
  const draft = heldDraft ?? ownDraft;
  const setDraft = onDraftChange ?? setOwnDraft;
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const nativePaths = canRequestNativeDirectoryAccess();

  const add = (value: string) => {
    const folder = value.trim();
    if (!isFullFolderPath(folder)) return;
    setDraft('');
    if (!folders.includes(folder)) onChange([...folders, folder]);
  };

  const browse = async () => {
    const result = await requestDirectoryAccess('');
    if (result.success && result.path) add(result.path);
  };

  return (
    <div className="space-y-2">
      {folders.length === 0 ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.extensions.folders.everywhere')}</p>
      ) : (
        <ul className="space-y-1">
          {folders.map((folder) => (
            <li key={folder} className="flex min-w-0 items-center gap-1">
              <span dir="ltr" className="typography-meta min-w-0 truncate font-mono text-foreground" title={folder}>{formatPathForDisplay(folder, homeDirectory)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                disabled={disabled}
                aria-label={t('settings.extensions.folders.remove.aria', { folder: formatPathForDisplay(folder, homeDirectory) })}
                onClick={() => onChange(folders.filter((entry) => entry !== folder))}
              >
                <Icon name="close" className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className={cn(SETTINGS_CONTROL_CLUSTER_CLASS, 'flex items-center gap-2')}>
        <div className="relative flex min-w-0 flex-1 items-center">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add(draft);
              }
            }}
            dir="ltr"
            placeholder={FOLDER_PLACEHOLDER}
            aria-label={t('settings.extensions.folders.input.aria')}
            className={cn('h-8 min-w-0 flex-1 rounded-md ps-3 font-mono', nativePaths ? 'pe-8' : 'pe-3')}
            disabled={disabled}
          />
          {nativePaths ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute inset-e-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={t('settings.extensions.folders.browse.aria')}
              disabled={disabled}
              onClick={() => void browse()}
            >
              <Icon name="folder" className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
        <Button type="button" variant="outline" disabled={disabled || !isFullFolderPath(draft)} onClick={() => add(draft)}>
          {t('settings.extensions.folders.add')}
        </Button>
      </div>
    </div>
  );
};

export const ExtensionFoldersSection: React.FC<{ guest: InstalledGuest; busy: boolean }> = ({ guest, busy }) => {
  const { t } = useI18n();
  const [saving, setSaving] = React.useState(false);

  const save = async (folders: string[]) => {
    setSaving(true);
    const ok = await setGuestFolders(guest.id, folders);
    if (!ok) {
      setSaving(false);
      toast.error(t('settings.extensions.folders.toast.failed'));
      return;
    }
    await reloadGuestCatalog();
    setSaving(false);
  };

  return (
    <SettingsSection title={t('settings.extensions.folders.title')} info={t('settings.extensions.folders.info')}>
      <ExtensionFoldersField folders={guest.folders ?? []} disabled={busy || saving} onChange={(folders) => void save(folders)} />
    </SettingsSection>
  );
};

export const ExtensionInstallFolders: React.FC<FoldersFieldProps & HeldDraftProps> = (props) => {
  const { t } = useI18n();
  return (
    <SettingsStackedField
      label={t('settings.extensions.folders.title')}
      info={t('settings.extensions.folders.info')}
      controlClassName="w-full max-w-none"
    >
      <ExtensionFoldersField {...props} />
    </SettingsStackedField>
  );
};
