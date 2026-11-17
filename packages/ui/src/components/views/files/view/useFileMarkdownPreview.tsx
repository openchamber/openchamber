import React from 'react';
import { isEditableEventTarget } from '@/hooks/keyboard-shortcut-dom';
import { type useFileKinds } from './useFileKinds';
import { type useFileTabs } from './useFileTabs';
import { type useFileViewModes } from './useFilePreviewModes';

export function useFileMarkdownPreview() {
  // In-preview find for the rendered Markdown preview (Ctrl/Cmd+F).
  const [mdPreviewFindOpen, setMdPreviewFindOpen] = React.useState(false);
  const [mdPreviewFindFocusNonce, setMdPreviewFindFocusNonce] = React.useState(0);
  // The outline of the rendered Markdown preview. Closed whenever a preview opens; never stored.
  const [mdPreviewOutlineOpen, setMdPreviewOutlineOpen] = React.useState(false);
  const mdPreviewContainerRef = React.useRef<HTMLDivElement | null>(null);
  // Give the rendered preview keyboard focus (without scrolling it) unless the
  // user is typing somewhere else, so Cmd/Ctrl+F opens the preview find bar
  // right after a Markdown file opens and after any click inside it.
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
  const mdFullscreenPreviewContainerRef = React.useRef<HTMLDivElement | null>(null);

  return { mdPreviewFindOpen, setMdPreviewFindOpen, mdPreviewFindFocusNonce, setMdPreviewFindFocusNonce, mdPreviewOutlineOpen, setMdPreviewOutlineOpen, mdPreviewContainerRef, focusMdPreviewContainer, mdFullscreenPreviewContainerRef };
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
  // The outline lists the rendered preview's headings: it closes when the
  // preview goes away and when another file opens.
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
