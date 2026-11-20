import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { Icon } from '@/components/icon/Icon';

type SessionRowChevronProps = {
  expanded: boolean;
  onToggle: () => void;
};

export function SessionTreeChevron({ expanded, onToggle }: SessionRowChevronProps): React.ReactNode {
  const { t } = useI18n();
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.blur();
        onToggle();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }
      }}
      className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={expanded
        ? t('sessions.sidebar.session.subsessions.collapse')
        : t('sessions.sidebar.session.subsessions.expand')}
      aria-expanded={expanded}
    >
      <FileTreeChevron expanded={expanded} />
    </span>
  );
}

export function SessionLeadToggle({ expanded, alwaysShowActions, onToggle }: SessionRowChevronProps & { alwaysShowActions: boolean }): React.ReactNode {
  const { t } = useI18n();
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.blur();
        onToggle();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }
      }}
      className={cn(
        'absolute inset-0 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none',
        !alwaysShowActions && 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100',
      )}
      aria-label={expanded
        ? t('sessions.sidebar.session.subsessions.collapse')
        : t('sessions.sidebar.session.subsessions.expand')}
      aria-expanded={expanded}
    >
      <FileTreeChevron expanded={expanded} />
    </span>
  );
}

export function SessionLeadSlot({ chevron, alwaysShowActions }: { chevron: React.ReactNode | null; alwaysShowActions: boolean }): React.ReactNode {
  const { t } = useI18n();
  const flag = <Icon name="lead-flag" className="h-3.5 w-3.5 text-muted-foreground" role="img" aria-label={t('sessions.sidebar.session.leadMark')} aria-hidden={false} />;
  if (!chevron) return <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">{flag}</span>;
  return (
    <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
      <span className={cn('inline-flex items-center justify-center', !alwaysShowActions && 'group-hover:opacity-0 group-has-[:focus-visible]:opacity-0')}>{flag}</span>
      <span className={cn('absolute inset-0 inline-flex items-center justify-center opacity-0', !alwaysShowActions && 'group-hover:opacity-100 group-has-[:focus-visible]:opacity-100')}>{chevron}</span>
    </span>
  );
}
