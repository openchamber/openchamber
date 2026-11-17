import React from 'react';

import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type AutocompleteScope = 'user' | 'project' | 'opencode' | 'openchamber';

const SCOPE_TONE = {
  project: 'bg-[color-mix(in_srgb,var(--status-info)_12%,transparent)] text-[color-mix(in_srgb,var(--status-info)_70%,transparent)] border-[color-mix(in_srgb,var(--status-info)_24%,transparent)]',
  user: 'bg-[color-mix(in_srgb,var(--status-success)_12%,transparent)] text-[color-mix(in_srgb,var(--status-success)_70%,transparent)] border-[color-mix(in_srgb,var(--status-success)_24%,transparent)]',
  other: 'bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60',
} as const;

const SCOPE_LABEL = {
  user: 'chat.autocomplete.scope.user',
  project: 'chat.autocomplete.scope.project',
  opencode: 'chat.autocomplete.scope.opencode',
  openchamber: 'chat.autocomplete.scope.openchamber',
} as const;

export function AutocompleteLoadingRow() {
  const { t } = useI18n();
  return (
    <div className="flex items-center px-2 py-1.5 typography-ui-label text-muted-foreground">
      <span className="flex h-[1lh] items-center">
        <Spinner className="size-3.5" aria-label={t('common.loading')} />
      </span>
    </div>
  );
}

export function AutocompleteRowDetail({ scope, extension, description }: {
  scope?: AutocompleteScope | null;
  extension?: string;
  description?: string | null;
}) {
  const { t } = useI18n();
  const text = description?.replace(/\s+/g, ' ').trim();
  const label = extension ?? (scope ? t(SCOPE_LABEL[scope]) : null);
  return (
    <>
      <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">{text}</span>
      {label ? (
        <span
          className={cn(
            'max-w-32 shrink-0 truncate rounded border px-1.5 py-1 text-[0.625rem] font-bold uppercase leading-none tracking-tight',
            scope === 'project' ? SCOPE_TONE.project : scope === 'user' ? SCOPE_TONE.user : SCOPE_TONE.other,
          )}
        >
          {label}
        </span>
      ) : null}
    </>
  );
}
