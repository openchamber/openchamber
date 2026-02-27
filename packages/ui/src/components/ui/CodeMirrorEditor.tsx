import React from 'react';

import type { Extension } from '@codemirror/state';
import { Compartment, EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, type KeyBinding, ViewPlugin, WidgetType, gutters, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { forceParsing, indentUnit } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

export type BlockWidgetDef = {
  afterLine: number;
  id: string;
  content: React.ReactNode;
};

type CodeMirrorEditorProps = {
  value: string;
  onChange: (value: string) => void;
  extensions?: Extension[];
  className?: string;
  readOnly?: boolean;
  lineNumbersConfig?: Parameters<typeof lineNumbers>[0];
  highlightLines?: { start: number; end: number };
  blockWidgets?: BlockWidgetDef[];
  onViewReady?: (view: EditorView) => void;
  onViewDestroy?: () => void;
  enableSearch?: boolean;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
};

const lineNumbersCompartment = new Compartment();
const editableCompartment = new Compartment();
const externalExtensionsCompartment = new Compartment();
const highlightLinesCompartment = new Compartment();
const blockWidgetsCompartment = new Compartment();
const searchCompartment = new Compartment();

const toViewKeyBindings = (bindings: readonly unknown[]): readonly KeyBinding[] => {
  return bindings as readonly KeyBinding[];
};

const forceParsingCompat = forceParsing as unknown as (view: EditorView, upto?: number, timeout?: number) => boolean;
const openSearchPanelCompat = openSearchPanel as unknown as (view: EditorView) => void;
const closeSearchPanelCompat = closeSearchPanel as unknown as (view: EditorView) => void;

// BlockWidget class definition moved inside helper or adapted to take map
class BlockWidget extends WidgetType {
  constructor(readonly id: string, readonly containerMap: Map<string, HTMLElement>) {
    super();
  }

  toDOM() {
    let div = this.containerMap.get(this.id);
    if (!div) {
      div = document.createElement('div');
      div.className = 'oc-block-widget';
      div.dataset.widgetId = this.id;
      this.containerMap.set(this.id, div);
    }
    return div;
  }

  eq(other: BlockWidget) {
    return other.id === this.id;
  }
  
  destroy() {
    // We do NOT remove from map here because CM might destroy the widget
    // when it scrolls out of view, but we want to reuse the same container (and Portal)
    // when it scrolls back in.
  }
}

const createBlockWidgetsExtension = (widgets: BlockWidgetDef[] | undefined, containerMap: Map<string, HTMLElement>) => {
  if (!widgets || widgets.length === 0) return [];

  return StateField.define<DecorationSet>({
    create(state) {
      const builder = new RangeSetBuilder<Decoration>();
      // Sort widgets by line number to add them in order
      const sorted = [...widgets].sort((a, b) => a.afterLine - b.afterLine);
      
      for (const w of sorted) {
        const lineCount = state.doc.lines;
        if (w.afterLine > lineCount) continue;
        
        const line = state.doc.line(w.afterLine);
        // Add widget decoration
        builder.add(line.to, line.to, Decoration.widget({
          widget: new BlockWidget(w.id, containerMap),
          block: true,
          side: 1, 
        }));
      }
      return builder.finish();
    },
    update(deco, tr) {
      // If the doc changed, map the decorations.
      // If the widgets prop changed, the compartment reconfigure will handle it (create() will run).
      return deco.map(tr.changes);
    },
    provide: f => EditorView.decorations.from(f)
  });
};


const createHighlightLinesExtension = (range?: { start: number; end: number }): Extension => {
  if (!range) {
    return [];
  }

  const start = Math.max(1, range.start);
  const end = Math.max(start, range.end);

  return ViewPlugin.fromClass(class {
    decorations;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: import('@codemirror/view').ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      for (let lineNo = start; lineNo <= end && lineNo <= view.state.doc.lines; lineNo += 1) {
        const line = view.state.doc.line(lineNo);
        builder.add(line.from, line.from, Decoration.line({ class: 'oc-cm-selected-line' }));
      }
      return builder.finish();
    }
  }, { decorations: (v) => v.decorations });
};

export function CodeMirrorEditor({
  value,
  onChange,
  extensions,
  className,
  readOnly,
  lineNumbersConfig,
  highlightLines,
  onViewReady,
  onViewDestroy,
  blockWidgets,
  enableSearch,
  searchOpen,
}: CodeMirrorEditorProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const valueRef = React.useRef(value);
  const onChangeRef = React.useRef(onChange);
  const onViewReadyRef = React.useRef(onViewReady);
  const onViewDestroyRef = React.useRef(onViewDestroy);
  const blockWidgetsRef = React.useRef(blockWidgets);
  
  // Scoped map for widget containers to avoid global collisions and memory leaks
  const widgetContainersRef = React.useRef(new Map<string, HTMLElement>());
  const [portalWidgets, setPortalWidgets] = React.useState<Array<{ id: string; content: React.ReactNode; container: HTMLElement }>>([]);

  const syncPortalWidgets = React.useCallback((widgets?: BlockWidgetDef[]) => {
    const next = (widgets ?? [])
      .map((widget) => {
        const container = widgetContainersRef.current.get(widget.id);
        if (!container) {
          return null;
        }
        return {
          id: widget.id,
          content: widget.content,
          container,
        };
      })
      .filter((widget): widget is { id: string; content: React.ReactNode; container: HTMLElement } => widget !== null);

    setPortalWidgets((prev) => {
      if (
        prev.length === next.length &&
        prev.every((widget, index) => {
          const candidate = next[index];
          return (
            widget.id === candidate.id &&
            widget.content === candidate.content &&
            widget.container === candidate.container
          );
        })
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const syncEditorCssVars = React.useCallback((view?: EditorView | null) => {
    const host = hostRef.current;
    const resolvedView = view ?? viewRef.current;
    if (!host || !resolvedView) {
      return;
    }

    const gutters = resolvedView.dom.querySelector('.cm-gutters');
    const gutterWidth = gutters instanceof HTMLElement ? gutters.getBoundingClientRect().width : 0;
    host.style.setProperty('--oc-editor-gutter-width', `${gutterWidth}px`);
  }, []);

  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    onViewReadyRef.current = onViewReady;
    onViewDestroyRef.current = onViewDestroy;
  }, [onViewReady, onViewDestroy]);

  React.useEffect(() => {
    blockWidgetsRef.current = blockWidgets;
    syncPortalWidgets(blockWidgets);
  }, [blockWidgets, syncPortalWidgets]);

  React.useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const cspNonce = (() => {
      if (typeof document === 'undefined') return null;
      const metaNonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content');
      if (metaNonce) return metaNonce;
      const windowNonce = (window as Window & { __OPENCHAMBER_CSP_NONCE__?: string }).__OPENCHAMBER_CSP_NONCE__;
      return typeof windowNonce === 'string' && windowNonce.length > 0 ? windowNonce : null;
    })();

    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
        gutters({ fixed: true }),
        lineNumbersCompartment.of(lineNumbers(lineNumbersConfig)),
        history(),
        indentUnit.of('  '),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          syncEditorCssVars(update.view);
          if (update.viewportChanged || update.geometryChanged) {
            syncPortalWidgets(blockWidgetsRef.current);
          }
          if (!update.docChanged) {
            return;
          }
          const next = update.state.doc.toString();
          valueRef.current = next;
          onChangeRef.current(next);
          syncPortalWidgets(blockWidgetsRef.current);
        }),
        editableCompartment.of(EditorView.editable.of(!readOnly)),
        externalExtensionsCompartment.of(extensions ?? []),
        highlightLinesCompartment.of(createHighlightLinesExtension(highlightLines)),
        blockWidgetsCompartment.of(createBlockWidgetsExtension(blockWidgets, widgetContainersRef.current)),
        searchCompartment.of(enableSearch ? [search({ top: true }), keymap.of(toViewKeyBindings(searchKeymap))] : []),
      ],
    });

    viewRef.current = new EditorView({
      state,
      parent: hostRef.current,
    });

    forceParsingCompat(viewRef.current, viewRef.current.state.doc.length, 200);
    viewRef.current.requestMeasure();
    requestAnimationFrame(() => {
      syncEditorCssVars(viewRef.current);
      syncPortalWidgets(blockWidgetsRef.current);
    });

    if (viewRef.current) {
      onViewReadyRef.current?.(viewRef.current);
    }

    return () => {
      onViewDestroyRef.current?.();
      viewRef.current?.destroy();
      viewRef.current = null;
      setPortalWidgets([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockWidgetsRef, syncEditorCssVars, syncPortalWidgets]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({
      effects: [
        lineNumbersCompartment.reconfigure(lineNumbers(lineNumbersConfig)),
        editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
        externalExtensionsCompartment.reconfigure(extensions ?? []),
        highlightLinesCompartment.reconfigure(createHighlightLinesExtension(highlightLines)),
        blockWidgetsCompartment.reconfigure(createBlockWidgetsExtension(blockWidgets, widgetContainersRef.current)),
        searchCompartment.reconfigure(enableSearch ? [search({ top: true }), keymap.of(toViewKeyBindings(searchKeymap))] : []),
      ],
    });

    forceParsingCompat(view, view.state.doc.length, 200);
    view.requestMeasure();
    requestAnimationFrame(() => {
      syncEditorCssVars(view);
      syncPortalWidgets(blockWidgetsRef.current);
    });
  }, [extensions, highlightLines, lineNumbersConfig, readOnly, blockWidgets, enableSearch, syncEditorCssVars, syncPortalWidgets]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || enableSearch === false) {
      return;
    }
    if (searchOpen) {
      openSearchPanelCompat(view);
    } else {
      closeSearchPanelCompat(view);
    }
  }, [searchOpen, enableSearch]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
      forceParsingCompat(view, view.state.doc.length, 300);
      view.requestMeasure();
      requestAnimationFrame(() => syncEditorCssVars(view));
    }
  }, [value, syncEditorCssVars]);

  return (
    <>
      <div
        ref={hostRef}
        className={cn(
          'h-full w-full',
          '[&_.cm-editor]:h-full [&_.cm-editor]:w-full',
          '[&_.cm-scroller]:font-mono [&_.cm-scroller]:text-[var(--text-code)] [&_.cm-scroller]:leading-6',
          '[&_.cm-lineNumbers]:text-[var(--tools-edit-line-number)]',
          className,
        )}
      />
      {portalWidgets.map((widget) => {
        return createPortal(widget.content, widget.container, widget.id);
      })}
    </>
  );
}
