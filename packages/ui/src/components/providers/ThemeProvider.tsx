import React from 'react';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { useUIStore } from '@/stores/useUIStore';

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
      const isEditor = active?.closest('.cm-editor') != null
        && active?.closest('[data-chat-input="true"]') == null;
      if (action === 'zoom-reset') {
        if (isTerminal) state.setTerminalFontSize(14);
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
    window.addEventListener('openchamber:zoom', handleZoom);
    return () => window.removeEventListener('openchamber:zoom', handleZoom);
  }, []);

  return <>{children}</>;
};
