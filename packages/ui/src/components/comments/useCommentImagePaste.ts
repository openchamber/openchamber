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

/** Where a paste's citations go: replace `[from, to)` of the comment with `insertion`. */
interface CommentImageInsertion {
  from: number;
  to: number;
  insertion: string;
}

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
  // Live set of the pending names, read by the comment editor so a citation
  // renders as a chip the moment it is inserted.
  const pendingFilenamesRef = React.useRef(new Set<string>());

  /**
   * Takes the images out of a paste into a comment whose text is `value` with
   * `selection` selected, and returns where their citations go, or null when
   * the paste carries no image and belongs to the field. The caller cancels
   * the paste and applies the insertion.
   */
  const takePastedImages = React.useCallback((
    clipboardData: DataTransfer,
    value: string,
    selection: { start: number; end: number },
  ): CommentImageInsertion | null => {
    const images = clipboardImages(clipboardData);
    if (images.length === 0) return null;

    const filenames = assignImageAttachmentFilenames(images, [
      ...useInputStore.getState().attachedFiles.map((file) => file.filename),
      ...pendingRef.current.keys(),
    ]);
    filenames.forEach((filename, index) => {
      pendingRef.current.set(filename, renameFileForAttachmentCitation(images[index], filename));
      pendingFilenamesRef.current.add(filename);
    });

    // Text that came along with the images stays, as in the composer.
    const insertion = withInlineInsertionBoundaries(
      buildImagePasteInsertion(clipboardData.getData('text'), buildAttachmentCitationText(filenames)),
      value.slice(0, selection.start),
      value.slice(selection.end),
    );
    return { from: selection.start, to: selection.end, insertion };
  }, []);

  /** Attaches the pasted images still cited in the final comment text. */
  const attachCitedImages = React.useCallback(async (commentText: string): Promise<void> => {
    const cited = Array.from(pendingRef.current)
      .filter(([filename]) => commentText.includes(buildAttachmentCitationText([filename])))
      .map(([, file]) => file);
    pendingRef.current.clear();
    pendingFilenamesRef.current.clear();

    const { addAttachedFile } = useInputStore.getState();
    for (const file of cited) {
      const attached = await addAttachedFile(file).catch(() => false);
      if (!attached) toast.error(t('chat.chatInput.toast.clipboardAttachFailed'));
    }
  }, [t]);

  const discardPastedImages = React.useCallback(() => {
    pendingRef.current.clear();
    pendingFilenamesRef.current.clear();
  }, []);

  return {
    takePastedImages,
    attachCitedImages,
    discardPastedImages,
    pendingFilenames: pendingFilenamesRef.current,
  };
};

export type CommentImagePaste = ReturnType<typeof useCommentImagePaste>;
