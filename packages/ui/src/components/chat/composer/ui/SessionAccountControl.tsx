import React from 'react';

import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import {
  fetchLimitAccounts,
  fetchSessionAccount,
  modelWindows,
  setSessionAccount,
  windowPercent,
  type LimitAccount,
  type SessionAccountPin,
} from '@/lib/limit-failover/client';
import { useConfigStore } from '@/stores/useConfigStore';

const ACCOUNT_PROVIDER = 'anthropic';

const formatReset = (resetAt: number): string => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}).format(resetAt);

/**
 * The account a session runs on, and whether a limit may move it. Shown only
 * for a provider with several stored accounts, beside the model picker.
 */
export const SessionAccountControl: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const providerId = useConfigStore((state) => state.currentProviderId);
  const [accounts, setAccounts] = React.useState<LimitAccount[] | null>(null);
  const [pin, setPin] = React.useState<SessionAccountPin | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (providerId !== ACCOUNT_PROVIDER || !sessionId) {
      setAccounts(null);
      setPin(null);
      return;
    }
    let active = true;
    void Promise.all([fetchLimitAccounts(providerId), fetchSessionAccount(sessionId)])
      .then(([nextAccounts, nextPin]) => {
        if (!active) return;
        setAccounts(nextAccounts);
        setPin(nextPin);
      })
      .catch(() => {
        if (active) setAccounts(null);
      });
    return () => {
      active = false;
    };
  }, [providerId, sessionId]);

  if (providerId !== ACCOUNT_PROVIDER || !sessionId || !accounts || accounts.length < 2) return null;

  const mode = pin?.mode ?? 'global';
  const chosen = accounts.find((account) => account.id === pin?.credentialID) ?? null;
  const triggerLabel = mode === 'global' ? t('chat.sessionAccount.mode.global') : (chosen?.label ?? t('chat.sessionAccount.mode.preferred'));

  const save = async (next: { mode: 'global' | 'preferred' | 'fixed'; credentialId?: string }) => {
    const previous = pin;
    setSaving(true);
    try {
      const saved = await setSessionAccount({ sessionId, providerId, mode: next.mode, credentialId: next.credentialId });
      setPin(saved);
    } catch {
      setPin(previous);
      toast.error(t('chat.sessionAccount.error'));
    } finally {
      setSaving(false);
    }
  };

  const chooseMode = (value: string) => {
    if (value === 'global') {
      void save({ mode: 'global' });
      return;
    }
    const credentialId = pin?.credentialID ?? accounts[0]?.id;
    if (!credentialId) return;
    void save({ mode: value === 'fixed' ? 'fixed' : 'preferred', credentialId });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label={t('chat.sessionAccount.button')}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 typography-ui-label text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
        >
          <Icon name="user" className="size-3.5 shrink-0" />
          <span className="max-w-24 truncate">{triggerLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t('chat.sessionAccount.button')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={chooseMode}>
          <DropdownMenuRadioItem value="global" className="flex-col items-start">
            <span>{t('chat.sessionAccount.mode.global')}</span>
            <span className="typography-meta text-muted-foreground">{t('chat.sessionAccount.mode.global.hint')}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="preferred" className="flex-col items-start">
            <span>{t('chat.sessionAccount.mode.preferred')}</span>
            <span className="typography-meta text-muted-foreground">{t('chat.sessionAccount.mode.preferred.hint')}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="fixed" className="flex-col items-start">
            <span>{t('chat.sessionAccount.mode.fixed')}</span>
            <span className="typography-meta text-muted-foreground">{t('chat.sessionAccount.mode.fixed.hint')}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {mode !== 'global' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={pin?.credentialID ?? ''}
              onValueChange={(credentialId) => void save({ mode, credentialId })}
            >
              {accounts.map((account) => (
                <DropdownMenuRadioItem key={account.id} value={account.id} className="flex-col items-start">
                  <span className="truncate">{account.label}</span>
                  <AccountUsageLine account={account} />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const AccountUsageLine: React.FC<{ account: LimitAccount }> = ({ account }) => {
  const { t } = useI18n();
  const windows = (['5h', '7d'] as const)
    .map((window) => ({ window, percent: windowPercent(account.usage, window) }))
    .filter((entry): entry is { window: '5h' | '7d'; percent: number } => entry.percent !== null);
  const models = modelWindows(account.usage);
  const exhaustion = account.exhausted[0];
  if (windows.length === 0 && models.length === 0 && !exhaustion) return null;
  return (
    <span className="flex flex-col typography-meta text-muted-foreground">
      {windows.length > 0 ? (
        <span>{windows.map((entry) => t('chat.sessionAccount.usage', { window: entry.window, used: Math.round(entry.percent) })).join(' · ')}</span>
      ) : null}
      {models.map((entry) => (
        <span key={entry.model}>{t('chat.sessionAccount.usage', { window: entry.model, used: Math.round(entry.usedPercent) })}</span>
      ))}
      {exhaustion ? (
        <span className={exhaustion.scope === '*' ? 'text-destructive' : 'text-[var(--status-warning-text)]'}>
          {exhaustion.scope === '*'
            ? t('chat.sessionAccount.exhaustedAccount', { time: formatReset(exhaustion.resetAt) })
            : t('chat.sessionAccount.exhaustedModel', { model: exhaustion.scope, time: formatReset(exhaustion.resetAt) })}
        </span>
      ) : null}
    </span>
  );
};
