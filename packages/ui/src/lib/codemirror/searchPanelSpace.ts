import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { searchPanelOpen } from '@codemirror/search';

export const setSearchPanelSpace = StateEffect.define<number>();

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
          view.scrollDOM.scrollTop = delta > 0 && scrollTop < delta ? 0 : scrollTop + delta;
        },
      });
    }
  }

  destroy() {
    this.observer?.disconnect();
  }

  private trackPanel() {
    this.view.requestMeasure({
      read: (view) => (searchPanelOpen(view.state) ? view.dom.querySelector('.cm-panels-top') : null),
      write: (panel) => {
        if (panel === this.panel) return;
        this.observer?.disconnect();
        this.observer = null;
        this.panel = panel;
        if (!panel) return;
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
