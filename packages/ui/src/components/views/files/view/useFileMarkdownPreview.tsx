import React from 'react';
import { isEditableEventTarget } from '@/hooks/keyboard-shortcut-dom';
import { type useFileKinds } from './useFileKinds';
import { type useFileTabs } from './useFileTabs';
import { type useFileViewModes } from './useFilePreviewModes';

export function useFileMarkdownPreview() {
  const [mdPreviewFindOpen, setMdPreviewFindOpen] = React.useState(false);
  const [mdPreviewFindFocusNonce, setMdPreviewFindFocusNonce] = React.useState(0);
  const [mdPreviewOutlineOpen, setMdPreviewOutlineOpen] = React.useState(false);
  const mdPreviewContainerRef = React.useRef<HTMLDivElement | null>(null);
  const focusMdPreviewContainer = React.useCallback((event?: React.MouseEvent<HTMLDivElement>) => {
    const container = event?.currentTarget ?? mdPreviewContainerRef.current;
    if (!container) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== container) {
      if (isEditableEventTarget(active)) return;
      if (container.contains(active)) return;
    }
    container.focus({ preventScroll: true });
  }, []);

  return { mdPreviewFindOpen, setMdPreviewFindOpen, mdPreviewFindFocusNonce, setMdPreviewFindFocusNonce, mdPreviewOutlineOpen, setMdPreviewOutlineOpen, mdPreviewContainerRef, focusMdPreviewContainer };
}

export function useFileMarkdownOutline({ fileKinds, markdownPreview, tabs, viewModes }: {
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'isMarkdown'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'setMdPreviewOutlineOpen'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'mdViewMode'>;
}) {
  const { isMarkdown } = fileKinds;
  const { setMdPreviewOutlineOpen } = markdownPreview;
  const { selectedFile } = tabs;
  const { mdViewMode } = viewModes;
  const mdPreviewShown = isMarkdown && mdViewMode === 'preview';
  React.useEffect(() => {
    if (!mdPreviewShown) setMdPreviewOutlineOpen(false);
  }, [mdPreviewShown]);
  const outlineFilePath = selectedFile?.path;
  React.useEffect(() => {
    setMdPreviewOutlineOpen(false);
  }, [outlineFilePath]);

  return {  };
}
