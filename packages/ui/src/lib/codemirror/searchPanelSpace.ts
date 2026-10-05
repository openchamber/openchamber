import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { searchPanelOpen } from '@codemirror/search';

/**
 * The search panel floats over the top of the editor, so at the top of a file it
 * covers the first lines. While it is open, the content gets a top padding as tall
 * as the panel: line 1 starts below the panel, and the space scrolls away with the
 * text, so further down the panel floats over the text as before.
 */
export const setSearchPanelSpace = StateEffect.define<number>();

// Room between the panel's bottom edge and line 1, matching CodeMirror's default content padding.
const GAP_PX = 4;

export const searchPanelSpaceField = StateField.define<number>({
  create: () => 0,
  update(space, tr) {
    if (!searchPanelOpen(tr.state)) return 0;
    for (const effect of tr.effects) {
      if (effect.is(setSearchPanelSpace)) space = effect.value;
    }
    return space;
  },
  provide: (field) => EditorView.contentAttributes.from(field, (space): Record<string, string> => (
    space > 0 ? { style: `padding-top: ${space}px` } : {}
  )),
});

// The space replaces the theme's own top padding, so compare what is actually applied.
const contentPaddingTop = (view: EditorView): number => parseFloat(getComputedStyle(view.contentDOM).paddingTop) || 0;

const searchPanelSpacePlugin = ViewPlugin.fromClass(class {
  private observer: ResizeObserver | null = null;
  private panel: Element | null = null;
  private padding = 0;

  constructor(private readonly view: EditorView) {
    view.requestMeasure({
      read: contentPaddingTop,
      write: (padding) => {
        this.padding = padding;
      },
    });
    this.trackPanel();
  }

  update(update: ViewUpdate) {
    if (searchPanelOpen(update.startState) !== searchPanelOpen(update.state)) {
      this.trackPanel();
    }
    if (update.state.field(searchPanelSpaceField) !== update.startState.field(searchPanelSpaceField)) {
      this.view.requestMeasure({
        read: (view) => ({ scrollTop: view.scrollDOM.scrollTop, padding: contentPaddingTop(view) }),
        write: ({ scrollTop, padding }, view) => {
          const delta = padding - this.padding;
          this.padding = padding;
          if (scrollTop === 0) return;
          // Scrolled into the file, keep the visible text still. Close enough to the top that the
          // panel would still cover line 1, show the top of the file instead, as at scrollTop 0.
          view.scrollDOM.scrollTop = delta > 0 && scrollTop < delta ? 0 : scrollTop + delta;
        },
      });
    }
  }

  destroy() {
    this.observer?.disconnect();
  }

  private trackPanel() {
    // The panel element is mounted during the update, so look for it once the DOM is in place.
    this.view.requestMeasure({
      read: (view) => (searchPanelOpen(view.state) ? view.dom.querySelector('.cm-panels-top') : null),
      write: (panel) => {
        if (panel === this.panel) return;
        this.observer?.disconnect();
        this.observer = null;
        this.panel = panel;
        if (!panel || typeof ResizeObserver === 'undefined') return;
        this.observer = new ResizeObserver(() => this.syncSpace());
        this.observer.observe(panel);
      },
    });
  }

  private syncSpace() {
    const { panel, view } = this;
    if (!panel || !searchPanelOpen(view.state)) return;
    const space = Math.ceil(panel.getBoundingClientRect().bottom - view.scrollDOM.getBoundingClientRect().top) + GAP_PX;
    if (space !== view.state.field(searchPanelSpaceField)) {
      view.dispatch({ effects: setSearchPanelSpace.of(space) });
    }
  }
});

export function searchPanelSpace(): Extension {
  return [searchPanelSpaceField, searchPanelSpacePlugin];
}
