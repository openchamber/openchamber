import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { foldGutter, foldKeymap } from '@codemirror/language';

// Fold arrows in the gutter plus fold/unfold of the block at the cursor
// (Cmd+Alt+[ / ] on macOS, Ctrl+Shift+[ / ] elsewhere). Fold-all and
// unfold-all are left out: their Ctrl+Alt+[ / ] chords cycle favourite models.
const FOLD_AT_CURSOR_KEYMAP = foldKeymap.filter((binding) => binding.mac !== undefined);

const createFoldMarker = (open: boolean): HTMLElement => {
  const marker = document.createElement('span');
  marker.className = 'cm-fold-marker';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', open ? '#oc-arrow-down-s' : '#oc-arrow-right-s');
  svg.appendChild(use);
  marker.appendChild(svg);
  return marker;
};

export const codeFolding = (): Extension => [
  foldGutter({ markerDOM: createFoldMarker }),
  keymap.of(FOLD_AT_CURSOR_KEYMAP),
  // A narrow column: just the 12 px arrow, and the gutter's trailing gap
  // shrunk to match, so the arrows sit close to the code they fold.
  EditorView.theme({
    '.cm-foldGutter': { width: '12px' },
    '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0' },
    '.cm-gutters:has(> .cm-foldGutter)': { paddingRight: '2px' },
    '.cm-fold-marker': { display: 'inline-flex', width: '12px', height: '12px', cursor: 'pointer', opacity: '0.6' },
    '.cm-fold-marker:hover': { opacity: '1' },
    '.cm-fold-marker svg': { width: '12px', height: '12px', fill: 'currentColor' },
  }),
];
