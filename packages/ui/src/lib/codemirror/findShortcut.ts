import { Prec, type Extension } from '@codemirror/state';
import { keymap, type KeyBinding } from '@codemirror/view';
import { openSearchPanel, searchKeymap } from '@codemirror/search';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';

// The find key follows Settings, so the default Mod-f entry gives way to a
// binding read from the store on each press. It runs ahead of the editing
// commands, because the key may be rebound onto one of them.
const findShortcut: KeyBinding = {
  scope: 'editor search-panel',
  any: (view, event) => {
    const combo = getEffectiveShortcutCombo('find_in_file', useUIStore.getState().shortcutOverrides);
    if (!eventMatchesShortcut(event, combo)) return false;
    event.preventDefault();
    openSearchPanel(view);
    return true;
  },
};

export const searchKeymapWithFindShortcut = (): Extension => [
  Prec.highest(keymap.of([findShortcut])),
  keymap.of(searchKeymap.filter((binding) => binding.key !== 'Mod-f')),
];
