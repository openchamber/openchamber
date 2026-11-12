import React from 'react';

import { cn } from '@/lib/utils';
import { KnowledgeRowContextMenu, type KnowledgeMenuItem } from './KnowledgeActions';

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
  /** The card's right-click menu: the items of its ⋯ menu. */
  menuItems?: KnowledgeMenuItem[];
  footer?: React.ReactNode;
}> = ({ entryId, selected = false, onOpen, label, header, children, actions, menuItems, footer }) => {
  const card = (
    <li
      data-knowledge-entry-id={entryId}
      className={cn(
        // A flat tile, set off by tone: layout carries no border.
        'group/knowledge flex cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors focus-visible:outline-none',
        selected ? 'bg-interactive-selection/40' : 'oc-tile oc-tile-hover focus-visible:bg-interactive-hover',
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
    />
  );
  const content = (
    <>
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
    </>
  );
  return menuItems && menuItems.length > 0
    ? <KnowledgeRowContextMenu items={menuItems} render={card}>{content}</KnowledgeRowContextMenu>
    : React.cloneElement(card, undefined, content);
};
