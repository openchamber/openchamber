import React from 'react';

import { findChatQuoteRoots, resolveChatQuoteRanges, type ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import {
  leaveSelectionComment,
  takeSelectionComment,
  type SelectionCommentHandoff,
} from '@/components/chat/message/selectionCommentHandoff';

interface SelectionCommentHandoffOptions {
  handoffKey: string | null;
  containerRef: React.RefObject<HTMLElement | null>;
  messageId: string;
  readDraft: () => SelectionCommentHandoff | null;
  restore: (draft: SelectionCommentHandoff, range: Range) => void;
}

const quoteRangeIn = (container: HTMLElement, messageId: string, anchor: ChatQuoteAnchor): Range | null => {
  const scope = container.closest('[data-scrollbar="chat"]');
  const roots = scope ? findChatQuoteRoots(scope, messageId) : [];
  const ranges = resolveChatQuoteRanges(roots.includes(container) ? roots : [container], anchor);
  const first = ranges?.[0];
  const last = ranges?.at(-1);
  if (!first || !last || !container.contains(first.startContainer)) return null;
  const range = first.cloneRange();
  range.setEnd(last.endContainer, last.endOffset);
  return range;
};

export const useSelectionCommentHandoff = ({ handoffKey, containerRef, messageId, readDraft, restore }: SelectionCommentHandoffOptions): void => {
  const ownerRef = React.useRef(Symbol('selection-comment'));
  const readDraftRef = React.useRef(readDraft);
  const restoreRef = React.useRef(restore);
  React.useLayoutEffect(() => {
    readDraftRef.current = readDraft;
    restoreRef.current = restore;
  });

  React.useLayoutEffect(() => {
    const owner = ownerRef.current;
    const latestDraft = readDraftRef;
    return () => {
      const draft = handoffKey ? latestDraft.current() : null;
      if (handoffKey && draft) leaveSelectionComment(handoffKey, owner, draft);
    };
  }, [handoffKey]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!handoffKey || !container) return;
    const taken = takeSelectionComment(handoffKey, ownerRef.current, (draft) => quoteRangeIn(container, messageId, draft.anchor));
    if (taken) restoreRef.current(taken.draft, taken.placed);
  }, [containerRef, handoffKey, messageId]);
};
