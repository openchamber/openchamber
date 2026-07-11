import type { Extension } from '@codemirror/state';
import type { EditorView, Panel } from '@codemirror/view';
import { drawSelection, showPanel } from '@codemirror/view';
import { getCM, vim } from '@replit/codemirror-vim';

type VimStatusPlugin = {
  updateStatus: () => void;
};

const isVimStatusPlugin = (value: unknown): value is VimStatusPlugin => {
  return (
    value !== null
    && typeof value === 'object'
    && 'updateStatus' in value
    && typeof value.updateStatus === 'function'
  );
};

const bottomVimStatusPanel = (view: EditorView): Panel => {
  const dom = document.createElement('div');
  dom.className = 'cm-vim-panel';

  const cm = getCM(view);
  if (!cm) {
    return { top: false, dom };
  }

  cm.state.statusbar = dom;
  const vimPlugin: unknown = cm.state.vimPlugin;
  // The Vim package exposes only a top status panel; reuse its updater with a bottom panel.
  if (isVimStatusPlugin(vimPlugin)) {
    vimPlugin.updateStatus();
  }

  return {
    top: false,
    dom,
    destroy() {
      if (cm.state.statusbar === dom) {
        cm.state.statusbar = null;
      }
    },
  };
};

export function createVimModeExtensions(enabled: boolean | undefined): Extension[] {
  if (!enabled) {
    return [];
  }

  return [vim(), showPanel.of(bottomVimStatusPanel), drawSelection()];
}
