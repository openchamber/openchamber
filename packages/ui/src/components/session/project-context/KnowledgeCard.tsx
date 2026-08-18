import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * One entry in any project knowledge list.
 *
 * Notes and memories drifted into two different-looking rows in the same panel:
 * one a bare block of text opened by clicking the text, the other a bordered
 * card opened by a chevron. They hold different content but they are the same
 * kind of thing to read, so they share this shell and this interaction.
 *
 * A collapsed card opens on a click anywhere on it — the whole card is the
 * target, not a chevron the user has to aim at. An expanded card closes only
 * through its collapse action, because its body is editable and a stray click
 * in the text must not throw the editor away.
 */
export const KnowledgeCard: React.FC<{
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Shown above the body: a badge, a title, whatever the section needs. */
  header?: React.ReactNode;
  /** The preview or the editor, depending on `expanded`. */
  children: React.ReactNode;
  /** Stacked to the right, so the text keeps the full row width. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  expandLabel: string;
}> = ({ expanded, onToggleExpanded, header, children, actions, footer, expandLabel }) => {
  const { t } = useI18n();

  return (
    <li
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5',
        !expanded && 'cursor-pointer hover:border-[var(--interactive-border)] hover:bg-interactive-hover/30',
      )}
      onClick={expanded ? undefined : onToggleExpanded}
      onKeyDown={expanded ? undefined : (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleExpanded();
        }
      }}
      role={expanded ? undefined : 'button'}
      tabIndex={expanded ? undefined : 0}
      aria-label={expanded ? undefined : expandLabel}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          {header}
          {children}
        </div>

        {/* Stopped here rather than on each control: every action is a click on
            the card too, and without this each one would also toggle it. */}
        <div
          className="flex flex-shrink-0 flex-col items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {expanded ? (
            <button
              type="button"
              onClick={onToggleExpanded}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={t('rightSidebar.contextNotesTodo.notes.actions.collapse')}
              title={t('rightSidebar.contextNotesTodo.notes.actions.collapse')}
            >
              <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {actions}
        </div>
      </div>

      {footer ? <div className="min-w-0">{footer}</div> : null}
    </li>
  );
};
