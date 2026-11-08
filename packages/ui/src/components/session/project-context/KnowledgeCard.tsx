import React from 'react';

import { cn } from '@/lib/utils';

/**
 * One entry in the notes and memory lists: a header line with the title and
 * the row actions, a short preview under it at full width, an optional footer.
 *
 * The card never changes height. A click anywhere on it opens the entry in
 * place of the list (`KnowledgeEntryView`); editing inside the list made every
 * card below jump on each open and close.
 */
export const KnowledgeCard: React.FC<{
  /** Lets the panel find the card again when the entry closes. */
  entryId: string;
  /** Open beside the list (split layout). */
  selected?: boolean;
  onOpen: () => void;
  /** Accessible name of the card: the entry's title. */
  label: string;
  header?: React.ReactNode;
  children?: React.ReactNode;
  /** Shown at the end of the header line, revealed on hover. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
}> = ({ entryId, selected = false, onOpen, label, header, children, actions, footer }) => (
  <li
    data-knowledge-entry-id={entryId}
    className={cn(
      'group/knowledge oc-surface-elevated flex cursor-pointer flex-col gap-1 rounded-lg border border-edge bg-surface-elevated px-2.5 py-2 transition-colors',
      'hover:border-[var(--interactive-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selected && 'border-[var(--interactive-selection)] bg-interactive-selection/40',
    )}
    aria-current={selected ? 'true' : undefined}
    onClick={onOpen}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    }}
    role="button"
    tabIndex={0}
    aria-label={label}
  >
    <div className="flex min-h-6 min-w-0 items-start gap-2">
      <div className="flex min-h-6 min-w-0 flex-1 items-center gap-1.5">{header}</div>

      {/* Stopped here rather than on each control: every action is a click on
          the card too, and without this each one would also open it. */}
      {actions ? (
        <div
          className="-me-1 flex flex-shrink-0 items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      ) : null}
    </div>

    {children}

    {footer ? <div className="min-w-0">{footer}</div> : null}
  </li>
);
