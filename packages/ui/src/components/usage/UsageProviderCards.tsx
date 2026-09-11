import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { formatQuotaResetLabel, formatQuotaValueLabel } from '@/lib/quota';
import { cn } from '@/lib/utils';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import type { UsageWindow } from '@/types';
import type { UsageProviderGroup } from './usageGroups';
import type { UsageLimitRow } from './usageGroups';

const getWindowValueClass = (window: UsageWindow): string => {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return 'text-foreground';
  if (usedPercent >= 80) return 'text-[var(--status-error)]';
  if (usedPercent >= 50) return 'text-[var(--status-warning)]';
  return 'text-foreground';
};

const UsageRows: React.FC<{
  rows: UsageLimitRow[];
  displayMode: 'usage' | 'remaining';
  timeFormatPreference: TimeFormatPreference;
}> = ({ rows, displayMode, timeFormatPreference }) => (
  <div className="mt-1.5 space-y-1">
    {rows.map((row) => {
      const displayPercent = displayMode === 'remaining'
        ? row.window.remainingPercent
        : row.window.usedPercent;
      const metricLabel = formatQuotaValueLabel(row.window.valueLabel, displayPercent);
      const resetLabel = formatQuotaResetLabel(
        row.window.resetAt,
        row.window.resetAfterFormatted ?? row.window.resetAtFormatted,
        timeFormatPreference,
      );
      return (
        <div key={row.key} className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="shrink-0 truncate typography-ui-label text-muted-foreground">
              {row.subtitle ? `${row.subtitle} · ${row.label}` : row.label}
            </span>
            {resetLabel ? (
              <span className="min-w-0 truncate typography-micro text-muted-foreground/70">
                {resetLabel}
              </span>
            ) : null}
          </span>
          <span className={cn('shrink-0 typography-ui-label font-semibold tabular-nums', getWindowValueClass(row.window))}>
            {metricLabel === '-' ? '' : metricLabel}
          </span>
        </div>
      );
    })}
  </div>
);

/**
 * One elevated card per provider, each holding a run of quota windows.
 *
 * Built for narrow columns: labels truncate, values stay pinned right, and
 * nothing relies on horizontal room the container may not have. Shared by the
 * mobile session-metadata popover and the work-status panel.
 */
export const UsageProviderCards: React.FC<{
  groups: UsageProviderGroup[];
  displayMode: 'usage' | 'remaining';
  timeFormatPreference: TimeFormatPreference;
  className?: string;
}> = ({ groups, displayMode, timeFormatPreference, className }) => (
  <div className={cn('space-y-1.5', className)}>
    {groups.map((group) => (
      <div key={group.providerId} className="min-w-0 rounded-xl bg-[var(--surface-muted)] p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderLogo providerId={group.providerId} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
            {group.providerName}
          </span>
          {group.planLabel ? (
            <span className="shrink-0 typography-micro capitalize text-muted-foreground">
              {group.planLabel}
            </span>
          ) : null}
          {group.status && group.rows.length === 0 && group.accounts.length === 0 ? (
            <span className="shrink-0 truncate typography-micro text-muted-foreground">{group.status}</span>
          ) : null}
        </div>

        {group.rows.length > 0 ? <UsageRows rows={group.rows} displayMode={displayMode} timeFormatPreference={timeFormatPreference} /> : null}

        {group.accounts.map((account) => (
          <div key={account.id} className={cn('mt-2 border-t border-border/50 pt-2', !account.available && 'opacity-60')}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">{account.label}</span>
              {account.status ? <span className="shrink-0 typography-micro text-muted-foreground">{account.status}</span> : null}
            </div>
            {account.detail ? <div className="truncate typography-micro text-muted-foreground/70">{account.detail}</div> : null}
            <UsageRows rows={account.rows} displayMode={displayMode} timeFormatPreference={timeFormatPreference} />
          </div>
        ))}

        {group.status && (group.rows.length > 0 || group.accounts.length > 0) ? (
          <div className="mt-1.5 typography-micro text-muted-foreground">{group.status}</div>
        ) : null}
      </div>
    ))}
  </div>
);
