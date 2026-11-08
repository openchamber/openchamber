import React from 'react';
import type { ConsoleBudget, ConsoleBudgets } from '@/types/quota';
import { formatQuotaResetLabel } from '@/lib/quota';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { UsageProgressBar } from './UsageProgressBar';

type Translate = ReturnType<typeof useI18n>['t'];

/** Names shown in a budget's label before the rest are counted. */
const SHOWN_MODEL_NAMES = 2;

const formatUsd = (amount: number): string => (
  new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'currency', currency: 'USD' }).format(amount)
);

const formatList = (items: string[]): string => (
  new Intl.ListFormat(getCurrentIntlLocale(), { type: 'conjunction' }).format(items)
);

/** What the budget counts, in the words the Console uses. */
const budgetLabel = (budget: ConsoleBudget, t: Translate): string => {
  const each = budget.perModel;
  const price = budget.inputPriceAtLeast === null ? null : formatUsd(budget.inputPriceAtLeast);
  switch (budget.kind) {
    case 'all':
      return t('settings.usage.consoleBudgets.kind.all');
    case 'vendors': {
      const vendors = formatList(budget.vendors);
      if (price !== null) {
        return each
          ? t('settings.usage.consoleBudgets.kind.vendorsPriceEach', { vendors, price })
          : t('settings.usage.consoleBudgets.kind.vendorsPrice', { vendors, price });
      }
      return each
        ? t('settings.usage.consoleBudgets.kind.vendorsEach', { vendors })
        : t('settings.usage.consoleBudgets.kind.vendors', { vendors });
    }
    case 'price':
      return each
        ? t('settings.usage.consoleBudgets.kind.priceEach', { price: price ?? '' })
        : t('settings.usage.consoleBudgets.kind.price', { price: price ?? '' });
    case 'models': {
      const models = budget.models.slice(0, SHOWN_MODEL_NAMES).join(', ');
      const count = budget.models.length - SHOWN_MODEL_NAMES;
      if (count > 0) {
        return each
          ? t('settings.usage.consoleBudgets.kind.modelsEachMore', { models, count })
          : t('settings.usage.consoleBudgets.kind.modelsMore', { models, count });
      }
      return each ? t('settings.usage.consoleBudgets.kind.modelsEach', { models }) : models;
    }
    case 'each':
      return t('settings.usage.consoleBudgets.kind.each');
  }
};

const sharingLabel = (budget: ConsoleBudget, workspace: string | null, t: Translate): string => {
  if (budget.sharing === 'you') return t('settings.usage.consoleBudgets.sharing.you');
  if (budget.sharing === 'group') return t('settings.usage.consoleBudgets.sharing.group');
  return workspace
    ? t('settings.usage.consoleBudgets.sharing.everyone', { workspace })
    : t('settings.usage.consoleBudgets.sharing.everyoneWorkspace');
};

const BudgetRow: React.FC<{ budget: ConsoleBudget; workspace: string | null }> = ({ budget, workspace }) => {
  const { t } = useI18n();
  const displayMode = useQuotaStore((state) => state.displayMode);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const left = Math.max(0, budget.limit - budget.spent);
  const displayPercent = displayMode === 'remaining' ? 100 - budget.usedPercent : budget.usedPercent;
  const resetLabel = formatQuotaResetLabel(budget.resetsAt, null, timeFormatPreference);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex flex-col">
          <span className="typography-ui-label text-foreground">{budgetLabel(budget, t)}</span>
          <span className="typography-meta text-muted-foreground">{sharingLabel(budget, workspace, t)}</span>
        </div>
        <div className={budget.reached
          ? 'typography-ui-label shrink-0 tabular-nums text-[var(--status-error)]'
          : 'typography-ui-label shrink-0 tabular-nums text-foreground'}
        >
          {budget.reached
            ? t('settings.usage.consoleBudgets.reached')
            : t('settings.usage.consoleBudgets.left', { amount: formatUsd(left) })}
        </div>
      </div>
      <div className="mt-2.5">
        <UsageProgressBar percent={displayPercent} tonePercent={budget.usedPercent} className="h-1.5" />
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="typography-micro text-muted-foreground">
            {resetLabel ? t('settings.usage.card.resetsAt', { time: resetLabel }) : ''}
          </span>
          <span className="typography-micro text-muted-foreground tabular-nums">
            {t('settings.usage.consoleBudgets.spentOf', { spent: formatUsd(budget.spent), limit: formatUsd(budget.limit) })}
          </span>
        </div>
      </div>
    </div>
  );
};

/** The Console budgets of the OpenCode Go sign-in, below its meters; ordered by what runs out first. */
export const ConsoleBudgetsSection: React.FC<{ consoleBudgets: ConsoleBudgets }> = ({ consoleBudgets }) => {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('settings.usage.consoleBudgets.title')}>
      <div className="divide-y divide-[var(--surface-subtle)]">
        {consoleBudgets.budgets.map((budget) => (
          <BudgetRow key={budget.id} budget={budget} workspace={consoleBudgets.workspace} />
        ))}
      </div>
    </SettingsSection>
  );
};
