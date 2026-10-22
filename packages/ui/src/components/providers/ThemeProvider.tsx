import React from 'react';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { useUIStore } from '@/stores/useUIStore';
import { DEFAULT_TERMINAL_FONT_SIZE } from '@/lib/terminalFontSize';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const fontSize = useUIStore((state) => state.fontSize);
  const applyTypography = useUIStore((state) => state.applyTypography);
  const padding = useUIStore((state) => state.padding);
  const applyPadding = useUIStore((state) => state.applyPadding);

  React.useLayoutEffect(() => {
    applyTypography();
    applyPadding();
  }, [fontSize, applyTypography, padding, applyPadding]);

  React.useEffect(() => {
    const handleZoom = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const action = event.detail;
      if (action !== 'zoom-in' && action !== 'zoom-out' && action !== 'zoom-reset') return;
      const active = document.activeElement;
      if (active?.tagName === 'WEBVIEW' || active?.closest('webview')) return;
      const state = useUIStore.getState();
      const isTerminal = isTerminalEventTarget(active)
        || active?.matches('[data-terminal-hidden-input="true"]') === true;
      // The rendered Markdown preview is sized by the editor font too.
      const isEditor = active?.closest('.cm-editor, .oc-file-preview') != null
        && active?.closest('[data-chat-input="true"]') == null;
      if (action === 'zoom-reset') {
        if (isTerminal) state.setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
        else if (isEditor) state.setEditorFontSize(13);
        else state.setFontSize(100);
      } else if (isTerminal) {
        state.setTerminalFontSize(state.terminalFontSize + (action === 'zoom-in' ? 1 : -1));
      } else if (isEditor) {
        state.setEditorFontSize(state.editorFontSize + (action === 'zoom-in' ? 1 : -1));
      } else {
        state.setFontSize(state.fontSize + (action === 'zoom-in' ? 10 : -10));
      }
    };
    const handleTerminalZoomKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
      if (event.metaKey === event.ctrlKey) return;
      const active = document.activeElement;
      if (!isTerminalEventTarget(active) && active?.matches('[data-terminal-hidden-input="true"]') !== true) return;
      const action = event.key === '=' ? 'zoom-in' : event.key === '-' ? 'zoom-out' : event.key === '0' ? 'zoom-reset' : null;
      if (!action) return;
      // Consume the key before the browser or desktop accelerator can zoom again.
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent('openchamber:zoom', { detail: action }));
    };
    window.addEventListener('openchamber:zoom', handleZoom);
    window.addEventListener('keydown', handleTerminalZoomKey, true);
    return () => {
      window.removeEventListener('openchamber:zoom', handleZoom);
      window.removeEventListener('keydown', handleTerminalZoomKey, true);
    };
  }, []);

  return <>{children}</>;
};
