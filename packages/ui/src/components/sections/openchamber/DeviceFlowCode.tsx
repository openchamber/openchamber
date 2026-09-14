import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsGroupTitle } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';

/**
 * Device-authorization step shared by the GitHub and GitLab cards: the code
 * to type into the provider, a way back to the provider page, and the quiet
 * "waiting" line with cancel. Kept identical so both providers read the same.
 */
export const DeviceFlowCode: React.FC<{
  code: string;
  description: string;
  openLabel: string;
  onOpen: () => void;
  onCancel: () => void;
  disabled?: boolean;
}> = ({ code, description, openLabel, onOpen, onCancel, disabled = false }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-3 rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-muted)] p-3">
      <div className="space-y-1">
        <SettingsGroupTitle>{t('settings.github.page.flow.title')}</SettingsGroupTitle>
        <p className="typography-meta text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <code className="rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-1.5 font-mono text-xl tracking-widest text-foreground">
          {code}
        </code>
        <Button size="sm" onClick={onOpen}>{openLabel}</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="typography-micro text-muted-foreground animate-pulse">
          {t('settings.github.page.flow.waiting')}
        </span>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          {t('settings.common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
};
