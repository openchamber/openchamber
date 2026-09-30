import React from 'react';
import type { ConnectionInfo } from '@opencode/client';
import { SETTINGS_ICON_BUTTON_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { CredentialConnection } from './providerAuth';

interface ProviderAccountsProps {
  /** Stored credentials first, then environment variables the server can see. */
  connections: readonly ConnectionInfo[];
  /** The one credential requests go through, when a stored credential is in use. */
  activeId: string | null;
  /**
   * Credentials stored under an integration the provider does not use right now
   * (OpenCode Go keys while the Console sign-in serves Go). Removable, never switchable.
   */
  unusedIds: ReadonlySet<string>;
  /** Credential id with a write in flight; every account action waits for it. */
  busyId: string | null;
  onActivate: (account: CredentialConnection) => void;
  onRename: (account: CredentialConnection, label: string) => void;
  onRemove: (account: CredentialConnection) => void;
}

const AccountTile: React.FC<{ icon: IconName }> = ({ icon }) => (
  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)] text-muted-foreground">
    <Icon name={icon} className="size-4" />
  </span>
);

const RenameField: React.FC<{
  initial: string;
  onSave: (label: string) => void;
  onCancel: () => void;
}> = ({ initial, onSave, onCancel }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(initial);
  const trimmed = value.trim();
  const save = () => {
    if (trimmed.length === 0 || trimmed === initial) {
      onCancel();
      return;
    }
    onSave(trimmed);
  };

  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        aria-label={t('settings.providers.accounts.nameAria')}
        className="h-8 max-w-[18rem]"
      />
      <Button type="submit" size="xs">{t('settings.providers.accounts.save')}</Button>
      <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
        {t('settings.providers.page.actions.cancel')}
      </Button>
    </form>
  );
};

/** Stored accounts and environment connections for one provider. */
export const ProviderAccounts: React.FC<ProviderAccountsProps> = ({
  connections,
  activeId,
  unusedIds,
  busyId,
  onActivate,
  onRename,
  onRemove,
}) => {
  const { t } = useI18n();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const switchableCount = connections.filter(
    (connection) => connection.type === 'credential' && !unusedIds.has(connection.id),
  ).length;
  // With a single usable account there is nothing to switch between, so it
  // carries no Use button; the Active mark still shows when idle ones sit next to it.
  const canSwitch = switchableCount > 1;
  const showActive = connections.filter((connection) => connection.type === 'credential').length > 1;

  return (
    <div className="divide-y divide-[var(--surface-subtle)]">
      {connections.map((connection) => {
        if (connection.type === 'env') {
          return (
            <div key={`env:${connection.name}`} className="flex min-w-0 items-center gap-3 py-2.5">
              <AccountTile icon="terminal-box" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono typography-ui-label text-foreground">{connection.name}</div>
                <div className="typography-micro text-muted-foreground">{t('settings.providers.accounts.environment')}</div>
              </div>
            </div>
          );
        }

        const active = connection.id === activeId;
        const unused = unusedIds.has(connection.id);
        const busy = busyId !== null;
        const methodLabel = connection.method === 'oauth'
          ? (unused ? t('settings.providers.accounts.method.oauthUnused') : t('settings.providers.accounts.method.oauth'))
          : (unused ? t('settings.providers.accounts.method.keyUnused') : t('settings.providers.accounts.method.key'));

        return (
          <div key={connection.id} className={cn('flex min-w-0 items-center gap-3 py-2.5', unused && 'opacity-60')}>
            <AccountTile icon={connection.method === 'oauth' ? 'user-3' : 'key'} />
            {renamingId === connection.id ? (
              <RenameField
                initial={connection.label}
                onCancel={() => setRenamingId(null)}
                onSave={(label) => {
                  setRenamingId(null);
                  onRename(connection, label);
                }}
              />
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate typography-ui-label font-medium text-foreground">{connection.label}</span>
                    {showActive && active ? (
                      <span className="shrink-0 rounded-full bg-[var(--interactive-selection)] px-2 py-px text-[10px] font-medium text-[var(--interactive-selection-foreground)]">
                        {t('settings.providers.accounts.active')}
                      </span>
                    ) : null}
                  </div>
                  <div className="typography-micro text-muted-foreground">
                    {methodLabel}
                  </div>
                </div>
                {canSwitch && !active && !unused ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => onActivate(connection)}
                    aria-label={t('settings.providers.accounts.useAria', { account: connection.label })}
                  >
                    {busyId === connection.id ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                    {t('settings.providers.accounts.use')}
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      className={cn(SETTINGS_ICON_BUTTON_CLASS, 'shrink-0')}
                      aria-label={t('settings.providers.accounts.menuAria', { account: connection.label })}
                    >
                      <Icon name="more-2" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenamingId(connection.id)}>
                      <Icon name="pencil" className="size-4" />
                      {t('settings.providers.accounts.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onRemove(connection)}
                    >
                      <Icon name="delete-bin" className="size-4" />
                      {t('settings.providers.accounts.remove')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};
