import type { ComponentType } from 'react';
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';

/** Props supplied by the selection toolbar to a module's action component. */
export interface SelectionActionProps {
  /** Read the current selection when the user activates the action. */
  getSelection: () => { markdownText: string; messageId: string | null; anchor: ChatQuoteAnchor | null } | null;
  /** Consume and dismiss the selection after the action succeeds. */
  onSuccess: () => void;
}

/**
 * Shared contract for selection features with desktop and mobile actions and
 * optional settings fields. Hosts choose where to mount each entry.
 *
 * A module checks its entry namespace with `satisfies SelectionModule` and
 * re-exports that same namespace. Consumers render the needed component, such
 * as `<SelectionApprovalModule.Desktop {...props} />`.
 */
export interface SelectionModule {
  Desktop: ComponentType<SelectionActionProps>;
  Mobile: ComponentType<SelectionActionProps>;
  Settings?: ComponentType;
}
