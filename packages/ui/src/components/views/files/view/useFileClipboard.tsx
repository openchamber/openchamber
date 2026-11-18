import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { type useFileKinds } from './useFileKinds';
import { type useFileDocument } from './useFileDocument';

export function useFileClipboard({ fileDocument, fileKinds, t }: {
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'displaySelectedPath'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { fileContent } = fileDocument;
  const { displaySelectedPath } = fileKinds;
  const copiedContentTimeoutRef = React.useRef<number | null>(null);
  const copiedPathTimeoutRef = React.useRef<number | null>(null);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [copiedPath, setCopiedPath] = React.useState(false);
  React.useEffect(() => {
    return () => {
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
      if (copiedPathTimeoutRef.current !== null) {
        window.clearTimeout(copiedPathTimeoutRef.current);
      }
    };
  }, []);
    const copyContents = async (announce: boolean) => {
      const result = await copyTextToClipboard(fileContent);
      if (!result.ok) {
        toast.error(t('filesView.toast.copyFailed'));
        return;
      }
      if (announce) {
        toast.success(t('filesView.editor.toast.contentsCopied'));
        return;
      }
      setCopiedContent(true);
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
      copiedContentTimeoutRef.current = window.setTimeout(() => {
        setCopiedContent(false);
      }, 1200);
    };

    const copyPath = async (announce: boolean) => {
      const result = await copyTextToClipboard(displaySelectedPath);
      if (!result.ok) {
        toast.error(t('filesView.toast.copyFailed'));
        return;
      }
      if (announce) {
        toast.success(t('sidebarFilesTree.toast.pathCopied'));
        return;
      }
      setCopiedPath(true);
      if (copiedPathTimeoutRef.current !== null) {
        window.clearTimeout(copiedPathTimeoutRef.current);
      }
      copiedPathTimeoutRef.current = window.setTimeout(() => {
        setCopiedPath(false);
      }, 1200);
    };

  return { copiedContent, copiedPath, copyContents, copyPath };
}
