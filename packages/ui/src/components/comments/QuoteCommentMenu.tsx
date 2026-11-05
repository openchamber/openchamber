import React from 'react';

import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { useComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { InlineCommentInput } from './InlineCommentInput';
import { SelectionCommentPopup } from './SelectionCommentPopup';

/**
 * Comment on a fragment the owner already worked out, for views where the
 * browser's own selection does not reach: table cells, a document in a frame.
 * Like every comment it only attaches to the composer and never sends.
 */
export function QuoteCommentMenu({ anchor, quote, fileLabel, onOpen, onClose }: {
  anchor: { x: number; y: number };
  /** What the agent gets: the place, then the content. */
  quote: string;
  fileLabel: string;
  /** The field took over from the bubble, and now holds what the user types. */
  onOpen?: () => void;
  onClose: () => void;
}) {
  const directory = useEffectiveDirectory();
  const target = useComposerDraftTarget(directory);
  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const [commentMode, setCommentMode] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      // SAFETY: a pointer event target inside the document is always a Node;
      // `contains` only needs that.
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [onClose]);

  const save = (text: string) => {
    if (target) {
      addDraft(target, { source: 'file-quote', fileLabel, startLine: 0, endLine: 0, code: quote, language: '', text: text.trim() });
      queueMicrotask(() => focusChatInput());
    }
    onClose();
  };

  return (
    <SelectionCommentPopup
      anchor={anchor}
      menuRef={menuRef}
      commentMode={commentMode}
      commentInput={<InlineCommentInput initialText="" fileLabel={fileLabel} onSave={save} onCancel={onClose} floating />}
      onComment={() => {
        setCommentMode(true);
        onOpen?.();
      }}
    />
  );
}
