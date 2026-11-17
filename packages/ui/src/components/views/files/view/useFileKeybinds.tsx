import { useKeybinds } from '@/hooks/useKeybind';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileSaving } from './useFileSaving';

export function useFileKeybinds({
  isMobile, isFullscreen, setIsSearchOpen, editorWrapperRef, canvasWrapperRef, setMdPreviewFindOpen,
  setMdPreviewFindFocusNonce, mdPreviewContainerRef, mdFullscreenPreviewContainerRef, saveNow, isMarkdownPreview,
}: Pick<ReturnType<typeof useFilesViewState>,
  'isMobile' | 'isFullscreen' | 'setIsSearchOpen' | 'editorWrapperRef' | 'canvasWrapperRef' |
  'setMdPreviewFindOpen' | 'setMdPreviewFindFocusNonce' | 'mdPreviewContainerRef' |
  'mdFullscreenPreviewContainerRef'> &
Pick<ReturnType<typeof useFileSaving>,
  'saveNow'> &
{ isMarkdownPreview: () => boolean }) {
  useKeybinds({
    // An extension editor's frame never forwards key events here; it sends
    // its own save request (`GuestFileEditor` → `saveNow`).
    save_file: (event) => {
      if (!(event.target instanceof Node)) return false;
      if (!editorWrapperRef.current?.contains(event.target) && !canvasWrapperRef.current?.contains(event.target)) return false;
      saveNow();
    },
    find_in_file: (event) => {
      if (!(event.target instanceof Node)) return false;

      // Rendered Markdown preview: open the in-preview find bar instead of the
      // editor search. Registered through the keybind schema rather than a raw
      // window listener so it cannot swallow Cmd/Ctrl+F app-wide while a
      // Markdown file happens to be selected behind another panel tab.
      if (isMarkdownPreview()) {
        if (isMobile) return false;
        const previewContainer = isFullscreen
          ? mdFullscreenPreviewContainerRef.current
          : mdPreviewContainerRef.current;
        if (!previewContainer?.contains(event.target)) return false;
        setMdPreviewFindOpen(true);
        setMdPreviewFindFocusNonce((value) => value + 1);
        return;
      }

      if (!editorWrapperRef.current?.contains(event.target)) return false;
      setIsSearchOpen(true);
    },
  });
}
