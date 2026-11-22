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
import { readComposerAttachmentTarget } from '@/hooks/useComposerAddress';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';

const clipboardImages = (data: DataTransfer): File[] => {
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

interface CommentImageInsertion {
  from: number;
  to: number;
  insertion: string;
}

export const useCommentImagePaste = () => {
  const { t } = useI18n();
  const pendingRef = React.useRef(new Map<string, File>());
  const pendingFilenamesRef = React.useRef(new Set<string>());

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

    const insertion = withInlineInsertionBoundaries(
      buildImagePasteInsertion(clipboardData.getData('text'), buildAttachmentCitationText(filenames)),
      value.slice(0, selection.start),
      value.slice(selection.end),
    );
    return { from: selection.start, to: selection.end, insertion };
  }, []);

  const attachCitedImages = React.useCallback(async (commentText: string, target: ChatDraftIdentity | null = readComposerAttachmentTarget()): Promise<void> => {
    const cited = Array.from(pendingRef.current)
      .filter(([filename]) => commentText.includes(buildAttachmentCitationText([filename])))
      .map(([, file]) => file);
    pendingRef.current.clear();
    pendingFilenamesRef.current.clear();

    const { addAttachedFile } = useInputStore.getState();
    for (const file of cited) {
      const attached = await addAttachedFile(file, target).catch(() => false);
      if (!attached) toast.error(t('chat.chatInput.toast.clipboardAttachFailed'));
    }
  }, [t]);

  const discardPastedImages = React.useCallback(() => {
    pendingRef.current.clear();
    pendingFilenamesRef.current.clear();
  }, []);

  const snapshotPastedImages = React.useCallback((): ReadonlyMap<string, File> => new Map(pendingRef.current), []);

  const adoptPastedImages = React.useCallback((images: ReadonlyMap<string, File>) => {
    for (const [filename, file] of images) {
      pendingRef.current.set(filename, file);
      pendingFilenamesRef.current.add(filename);
    }
  }, []);

  return {
    takePastedImages,
    attachCitedImages,
    discardPastedImages,
    snapshotPastedImages,
    adoptPastedImages,
    pendingFilenames: pendingFilenamesRef.current,
  };
};

export type CommentImagePaste = ReturnType<typeof useCommentImagePaste>;
