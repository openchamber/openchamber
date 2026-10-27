import React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Where an autocomplete item comes from; `opencode` and `openchamber` are the apps' own items. */
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

/**
 * The rest of an autocomplete row after its name: the description, muted on
 * one line and cut where it runs out of room, then the item's scope at the
 * end edge. Nothing pops up: the row says what it is at a glance.
 */
export function AutocompleteRowDetail({ scope, extension, description }: {
  scope?: AutocompleteScope | null;
  /** An extension's item names the extension in place of a scope. */
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
