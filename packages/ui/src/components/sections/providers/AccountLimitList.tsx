import React from 'react';

import { useI18n } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import { fetchLimitAccounts, modelWindows, windowPercent, type LimitAccount } from '@/lib/limit-failover/client';

const ACCOUNT_PROVIDER = 'anthropic';

const formatReset = (resetAt: number): string => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}).format(resetAt);

/**
 * Each stored account's plan usage and the limits the failover has seen run
 * out, for the provider page. Only Anthropic reports per-account usage, and
 * the list stays hidden until the plugin's first sweep has reported.
 */
export const AccountLimitList: React.FC<{ providerId: string }> = ({ providerId }) => {
  const { t } = useI18n();
  const [accounts, setAccounts] = React.useState<LimitAccount[] | null>(null);

  React.useEffect(() => {
    if (providerId !== ACCOUNT_PROVIDER) {
      setAccounts(null);
      return;
    }
    let active = true;
    void fetchLimitAccounts(providerId)
      .then((next) => {
        if (active) setAccounts(next);
      })
      .catch(() => {
        if (active) setAccounts(null);
      });
    return () => {
      active = false;
    };
  }, [providerId]);

  const visible = (accounts ?? []).filter((account) => account.usage !== null || account.exhausted.length > 0);
  if (providerId !== ACCOUNT_PROVIDER || visible.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1.5">
      {visible.map((account) => {
        const windows = (['5h', '7d'] as const)
          .map((window) => ({ window, percent: windowPercent(account.usage, window) }))
          .filter((entry): entry is { window: '5h' | '7d'; percent: number } => entry.percent !== null);
        return (
          <li key={account.id} className="flex flex-col typography-meta text-muted-foreground">
            <span className="text-foreground">{account.label}</span>
            {windows.length > 0 ? (
              <span>{windows.map((entry) => t('chat.sessionAccount.usage', { window: entry.window, used: Math.round(entry.percent) })).join(' · ')}</span>
            ) : null}
            {modelWindows(account.usage).map((entry) => (
              <span key={entry.model}>{t('chat.sessionAccount.usage', { window: entry.model, used: Math.round(entry.usedPercent) })}</span>
            ))}
            {account.exhausted.map((mark) => (
              <span key={mark.scope} className={mark.scope === '*' ? 'text-destructive' : 'text-[var(--status-warning-text)]'}>
                {mark.scope === '*'
                  ? t('chat.sessionAccount.exhaustedAccount', { time: formatReset(mark.resetAt) })
                  : t('chat.sessionAccount.exhaustedModel', { model: mark.scope, time: formatReset(mark.resetAt) })}
              </span>
            ))}
          </li>
        );
      })}
    </ul>
  );
};
