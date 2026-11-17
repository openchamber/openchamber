import React from 'react';

import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { toast } from '@/components/ui';
import { useComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { InlineCommentInput } from './InlineCommentInput';
import { SelectionCommentPopup } from './SelectionCommentPopup';

export function QuoteCommentMenu({ anchor, quote, fileLabel, onOpen, onClose }: {
  anchor: { x: number; y: number };
  quote: string;
  fileLabel: string;
  onOpen?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
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
      if (!addDraft(target, { source: 'file-quote', fileLabel, startLine: 0, endLine: 0, code: quote, language: '', text: text.trim() })) {
        toast.error(t('inlineComment.toast.noRoom'));
        return false;
      }
      queueMicrotask(() => focusChatInput());
    }
    onClose();
    return true;
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
