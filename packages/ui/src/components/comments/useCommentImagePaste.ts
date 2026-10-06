import React from 'react';

import { toast } from '@/components/ui';
import {
  assignImageAttachmentFilenames,
  buildAttachmentCitationText,
  renameFileForAttachmentCitation,
} from '@/components/chat/attachmentCitations';
import { buildImagePasteInsertion, withInlineInsertionBoundaries } from '@/components/chat/composer/text';
import { useI18n } from '@/lib/i18n';
import { useInputStore } from '@/sync/input-store';

const clipboardImages = (data: DataTransfer): File[] => {
  // The same image often arrives both as a file and as a file item.
  const images = new Map<string, File>();
  const collect = (file: File | null) => {
    if (file?.type.startsWith('image/')) images.set(`${file.name}-${file.size}`, file);
  };
  Array.from(data.files).forEach(collect);
  Array.from(data.items).forEach((item) => {
    if (item.kind === 'file') collect(item.getAsFile());
  });
  return Array.from(images.values());
};

/**
 * Images pasted into a comment. The comment text gets a `[image-1.png]`
 * citation, the same one the composer writes for a pasted image; the image
 * itself joins the composer's attachments only when the comment is attached,
 * so a cancelled comment leaves nothing behind, and an image whose citation
 * was deleted from the text is dropped.
 */
export const useCommentImagePaste = () => {
  const { t } = useI18n();
  const pendingRef = React.useRef(new Map<string, File>());

  /**
   * Takes the images out of a paste into `textarea` and returns the text with
   * their citations at the caret, or null when the paste carries no image
   * and belongs to the textarea.
   */
  const takePastedImages = React.useCallback((
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): { text: string; caret: number } | null => {
    const images = clipboardImages(event.clipboardData);
    if (images.length === 0) return null;
    event.preventDefault();

    const filenames = assignImageAttachmentFilenames(images, [
      ...useInputStore.getState().attachedFiles.map((file) => file.filename),
      ...pendingRef.current.keys(),
    ]);
    filenames.forEach((filename, index) => {
      pendingRef.current.set(filename, renameFileForAttachmentCitation(images[index], filename));
    });

    const { value, selectionStart, selectionEnd } = event.currentTarget;
    const before = value.slice(0, selectionStart);
    const after = value.slice(selectionEnd);
    // Text that came along with the images stays, as in the composer.
    const insertion = withInlineInsertionBoundaries(
      buildImagePasteInsertion(event.clipboardData.getData('text'), buildAttachmentCitationText(filenames)),
      before,
      after,
    );
    return { text: `${before}${insertion}${after}`, caret: before.length + insertion.length };
  }, []);

  /** Attaches the pasted images still cited in the final comment text. */
  const attachCitedImages = React.useCallback(async (commentText: string): Promise<void> => {
    const cited = Array.from(pendingRef.current)
      .filter(([filename]) => commentText.includes(buildAttachmentCitationText([filename])))
      .map(([, file]) => file);
    pendingRef.current.clear();

    const { addAttachedFile } = useInputStore.getState();
    for (const file of cited) {
      const attached = await addAttachedFile(file).catch(() => false);
      if (!attached) toast.error(t('chat.chatInput.toast.clipboardAttachFailed'));
    }
  }, [t]);

  const discardPastedImages = React.useCallback(() => {
    pendingRef.current.clear();
  }, []);

  return { takePastedImages, attachCitedImages, discardPastedImages };
};
