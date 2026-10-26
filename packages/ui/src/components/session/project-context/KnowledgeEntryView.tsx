import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from './knowledgeRowStyle';

/** Back to the list, at the start of an opened entry's own toolbar. */
export const KnowledgeBackButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`${KNOWLEDGE_ICON_BUTTON_CLASS} -ms-1`}
    aria-label={label}
    title={label}
  >
    <Icon name="arrow-left-s" className="h-4 w-4" />
  </button>
);

/**
 * An entry opened from a list, shown in place of that list.
 *
 * Notes and memories used to expand inside the list, which pushed every card
 * below them down and back up on each open and close. Opening one now swaps
 * the list for this view, the way a plan opens: the list never moves, and the
 * entry gets the whole panel. The back control starts the entry's own toolbar,
 * so the section tabs above never shift when an entry opens.
 *
 * Escape goes back to the list unless something inside (a menu, an IME)
 * already used it.
 */
export const KnowledgeEntryView: React.FC<{
  backLabel: string;
  /** False beside the list (split layout), where there is nothing to go back to. */
  showBack?: boolean;
  /** Details after the back control: source, date, scope. */
  meta: React.ReactNode;
  /** Controls at the end of the toolbar. */
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ backLabel, showBack = true, meta, actions, onClose, children }) => (
  <div
    // A readable line length in a wide panel; a narrow one never reaches it.
    className="flex h-full min-h-0 w-full max-w-3xl flex-col"
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      onClose();
    }}
  >
    <div className="flex min-h-7 flex-shrink-0 items-center gap-1.5 pb-2">
      {showBack ? <KnowledgeBackButton label={backLabel} onClick={onClose} /> : null}
      <div className="min-w-0 flex-1">{meta}</div>
      {actions ? <div className="-me-1 flex flex-shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
    <div className="min-h-0 flex-1">{children}</div>
  </div>
);
