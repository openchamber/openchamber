import type { Extension } from '@codemirror/state';
import type { EditorView, Panel } from '@codemirror/view';
import { drawSelection, showPanel } from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';

import { parseVimMappings, type VimMapping } from './vimMappings';

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

// The Vim keymap is global to the page, so the mappings applied last are
// tracked here and removed before a changed set is applied.
let appliedSource: string | null = null;
let applied: VimMapping[] = [];

/** Apply the user's vimrc map lines (see vimMappings.ts), replacing the previous set. */
export function syncVimMappings(source: string): void {
  if (source === appliedSource) return;
  for (const mapping of applied) {
    Vim.unmap(mapping.lhs, mapping.context);
  }
  const { mappings } = parseVimMappings(source);
  for (const mapping of mappings) {
    if (mapping.recursive) {
      Vim.map(mapping.lhs, mapping.rhs, mapping.context);
    } else {
      Vim.noremap(mapping.lhs, mapping.rhs, mapping.context);
    }
  }
  applied = mappings;
  appliedSource = source;
}
