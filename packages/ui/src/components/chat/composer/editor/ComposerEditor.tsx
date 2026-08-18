/**
 * The composer's text editor.
 *
 * This replaces the transparent-textarea-over-mirror-div arrangement the
 * composer used before. That arrangement could only paint styles which do not
 * change glyph advance width — colour, background, underline — because any
 * metric change made the mirror drift out from under the caret. Bold, italic
 * and any width-affecting affordance were therefore impossible, and the
 * overlay had to be disabled outright on mobile, where wrapped text drifted
 * anyway.
 *
 * CodeMirror owns the text and the caret together, so there is no second layer
 * to keep aligned. The document remains a plain string — `getValue()` is
 * exactly what gets sent — so nothing downstream has to serialize a rich
 * document model back into a prompt.
 *
 * The component is a controlled primitive: it renders `value`, reports edits,
 * and exposes an imperative handle for the caret-level operations the composer
 * performs (insert a mention, restore a draft, replace a token). Every policy
 * decision — what a key means, which picker opens, when to send — stays with
 * the caller.
 */

import React from 'react';
import { history, historyKeymap, standardKeymap } from '@codemirror/commands';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
    EditorView,
    drawSelection,
    keymap,
    placeholder as placeholderExtension,
    type KeyBinding,
} from '@codemirror/view';

import { cn } from '@/lib/utils';
import type { ComposerLanguageContext } from '../language/tokenize';
import { composerLanguage, setLanguageContext } from './composerLanguage';
import type { ComposerEditorViewStore } from './viewStore';
import { composerEditorTheme, composerNativeSelectionExtension } from './theme';
import { handleComposerHostMouseDown } from './hostMouseDown';

export interface ComposerSelection {
    start: number;
    end: number;
}

export interface ComposerChange {
    value: string;
    selection: ComposerSelection;
    /** True when the edit came from a paste rather than typing. */
    fromPaste: boolean;
    /** The text this edit inserted, empty for deletions. */
    insertedText: string;
}

export interface ComposerEditorHandle {
    focus(options?: { preventScroll?: boolean }): void;
    blur(): void;
    isFocused(): boolean;
    getValue(): string;
    getSelection(): ComposerSelection;
    setSelection(start: number, end?: number): void;
    selectAll(): void;
    /** Replace the current selection, leaving the caret after the insertion. */
    insertText(text: string): void;
    /** Replace an explicit range; the caret lands at `caret` or after the text. */
    replaceRange(from: number, to: number, text: string, caret?: number): void;
    /** Viewport coordinates of the caret, for positioning popups. */
    caretCoords(position?: number): { top: number; bottom: number; left: number } | null;
    /** The scrollable element, for measuring and scroll compensation. */
    getScrollDOM(): HTMLElement | null;
}

export interface ComposerEditorProps {
    value: string;
    onChange: (change: ComposerChange) => void;
    /** Caret or selection moved without the document changing. */
    onSelectionChange?: (selection: ComposerSelection) => void;
    /**
     * Key press before CodeMirror handles it. Return true to consume the
     * event — this is where the composer routes autocomplete navigation,
     * message history and send.
     */
    onKeyDown?: (event: KeyboardEvent) => boolean;
    onFocus?: () => void;
    onBlur?: () => void;
    onPaste?: (event: ClipboardEvent) => void;
    languageContext: ComposerLanguageContext;
    placeholder?: string;
    editable?: boolean;
    spellCheck?: boolean;
    /** Mobile keyboards; ignored on desktop. */
    autoCorrect?: boolean;
    autoCapitalize?: 'none' | 'sentences';
    /** Fill the available height instead of growing with the content. */
    fillContainer?: boolean;
    /** Lines of text shown before the editor starts scrolling. */
    maxLines?: number;
    /**
     * Selector of the ancestor the composer must never outgrow. The cap is
     * measured — the ancestor's height minus the chrome around the editor,
     * both read from the DOM — and the smaller of it and `maxLines` wins.
     */
    boundSelector?: string;
    /** Breathing room kept between the grown composer and the bound's edge. */
    boundGapPx?: number;
    className?: string;
    contentClassName?: string;
    /**
     * Keeps the underlying view alive across unmounts. Supply one from a parent
     * that outlives the swap; without it the view is built and destroyed with
     * the component, which is correct but expensive on an interaction path.
     */
    viewStore?: ComposerEditorViewStore;
    'aria-label'?: string;
    'data-testid'?: string;
}


/**
 * The text inserted by a transaction, used to tell a typed `@` from a pasted
 * one. CodeMirror reports the change set directly, so this needs none of the
 * prefix/suffix diffing a textarea's `onChange` required.
 */
function insertedTextOf(transaction: { changes: { iterChanges: (fn: (fromA: number, toA: number, fromB: number, toB: number, inserted: { toString(): string }) => void) => void } }): string {
    let inserted = '';
    transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
        inserted += text.toString();
    });
    return inserted;
}

/**
 * True for keydown events CodeMirror re-dispatches after deferring the real
 * one (iOS Enter/Backspace/Delete, Chrome Android Enter): `dispatchKey`
 * stamps the replacement event with a `synthetic` expando. These events are
 * built from the key name alone, so they carry no modifier keys.
 */
function isDeferredSyntheticEvent(event: KeyboardEvent): boolean {
    return Boolean((event as unknown as { synthetic?: boolean }).synthetic);
}

/**
 * Compartments are configuration keys, not per-view state, so one set can serve
 * every editor. They live at module scope because a kept-alive view outlives
 * the component that created it: per-instance compartments would be unknown to
 * the reused view's configuration, and reconfiguring it would throw.
 */
const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();

export const ComposerEditor = React.forwardRef<ComposerEditorHandle, ComposerEditorProps>(
    function ComposerEditor(props, ref) {
        const {
            value,
            languageContext,
            placeholder,
            editable = true,
            spellCheck = false,
            autoCorrect = false,
            autoCapitalize = 'none',
            fillContainer = false,
            maxLines = 8,
            boundSelector,
            boundGapPx = 0,
            className,
            contentClassName,
        } = props;

        const hostRef = React.useRef<HTMLDivElement | null>(null);
        const viewRef = React.useRef<EditorView | null>(null);

        // The real keydown's shift state for the LAST Enter that reached the
        // editor. CodeMirror defers Enter on iOS (and Chrome Android) and
        // re-dispatches it as a synthetic keydown built from the key name
        // alone, dropping every modifier (see `trackRealEnterShift` and the
        // `interceptKeys` handler below); this ref is what lets the deferred
        // event still tell Shift+Enter from Enter.
        const lastRealEnterShiftRef = React.useRef(false);

        // Callbacks reach the CodeMirror extensions through a ref: the view is
        // built once and must not be torn down when a handler identity changes,
        // which would drop focus mid-typing. When a view store is supplied the
        // ref lives there, so a kept-alive view keeps calling into whichever
        // component instance is currently mounted rather than a dead one.
        const localHandlersRef = React.useRef(props);
        const store = props.viewStore ?? null;
        if (store && !store.handlers) store.handlers = { current: props };
        const handlersRef = store?.handlers ?? localHandlersRef;
        handlersRef.current = props;

        // A layout effect, not a passive one: the mobile composer expands with
        // `flushSync` and focuses the editor on the next line, still inside the
        // tap's call stack, because that is the only way a mobile browser
        // raises the keyboard. flushSync commits layout effects but makes no
        // promise about passive ones, so creating the view there would leave
        // nothing to focus — the keyboard would rise later, from some other
        // path, and the composer would appear to transform only once it moved.
        React.useLayoutEffect(() => {
            const host = hostRef.current;
            if (!host) return;

            // A kept view is re-attached rather than rebuilt. Its extensions
            // already read through the shared handlers ref, so it needs nothing
            // from this instance beyond a parent to live in; the effects below
            // re-apply editable, placeholder, value and language context.
            const keptView = store?.view;
            if (keptView) {
                host.appendChild(keptView.dom);
                // Measurements taken while detached are meaningless; the view
                // re-reads its geometry now that it is back in the document.
                keptView.requestMeasure();
                viewRef.current = keptView;
                return () => {
                    keptView.dom.remove();
                    viewRef.current = null;
                };
            }

            const interceptKeys: KeyBinding[] = [{
                any: (_view, event) => {
                    // A deferred Enter lost its modifiers in the re-dispatch;
                    // give the caller's policy (Enter vs Shift+Enter) back the
                    // shift state it saw on the real keydown.
                    if (event.key === 'Enter' && isDeferredSyntheticEvent(event) && lastRealEnterShiftRef.current) {
                        Object.defineProperty(event, 'shiftKey', { value: true });
                    }
                    return handlersRef.current.onKeyDown?.(event) ?? false;
                },
            }];

            const view = new EditorView({
                state: EditorState.create({
                    doc: handlersRef.current.value,
                    extensions: [
                        history(),
                        // `drawSelection()` must stay even though the native
                        // selection is what actually shows (see the theme's
                        // comment on `composerNativeSelectionExtension`):
                        // removing it makes CodeMirror enforce cursor
                        // association on the native selection, which iOS
                        // answers with severe input lag.
                        drawSelection(),
                        composerNativeSelectionExtension,
                        EditorView.lineWrapping,
                        // Highest precedence: the composer's own keys must win
                        // over CodeMirror's defaults (Enter sends, ArrowUp
                        // walks history, Escape closes a picker).
                        Prec.highest(keymap.of(interceptKeys)),
                        keymap.of([...standardKeymap, ...historyKeymap]),
                        composerLanguage(handlersRef.current.languageContext),
                        editableCompartment.of(
                            EditorView.editable.of(handlersRef.current.editable ?? true),
                        ),
                        placeholderCompartment.of(
                            placeholderExtension(handlersRef.current.placeholder ?? ''),
                        ),
                        composerEditorTheme,
                        EditorView.updateListener.of((update) => {
                            const handlers = handlersRef.current;
                            const selection = readSelection(update.state);

                            if (update.docChanged) {
                                const fromPaste = update.transactions.some(
                                    (transaction) => transaction.isUserEvent('input.paste'),
                                );
                                let insertedText = '';
                                for (const transaction of update.transactions) {
                                    insertedText += insertedTextOf(transaction);
                                }
                                handlers.onChange({
                                    value: update.state.doc.toString(),
                                    selection,
                                    fromPaste,
                                    insertedText,
                                });
                                return;
                            }

                            if (update.selectionSet) {
                                handlers.onSelectionChange?.(selection);
                            }
                        }),
                        EditorView.domEventHandlers({
                            focus: () => { handlersRef.current.onFocus?.(); return false; },
                            blur: () => { handlersRef.current.onBlur?.(); return false; },
                            paste: (event) => { handlersRef.current.onPaste?.(event); return false; },
                        }),
                        EditorView.contentAttributes.of({
                            spellcheck: String(handlersRef.current.spellCheck ?? false),
                            autocorrect: handlersRef.current.autoCorrect ? 'on' : 'off',
                            autocapitalize: handlersRef.current.autoCapitalize ?? 'none',
                            ...(handlersRef.current['aria-label']
                                ? { 'aria-label': handlersRef.current['aria-label'] }
                                : {}),
                        }),
                    ] satisfies Extension[],
                }),
                parent: host,
            });

            viewRef.current = view;
            if (store) store.view = view;

            // CodeMirror defers Enter on iOS (and Chrome Android): the real
            // keydown is captured without running the keymaps, the browser's
            // native newline goes through, and the keymaps then run against a
            // synthetic keydown `dispatchKey` builds from the key name alone —
            // which has NO modifiers. Recording the real shift state here (a
            // plain listener, registered after CodeMirror's own, so it runs
            // after the deferral decision but before the deferred dispatch)
            // lets the deferred Enter be re-presented with Shift+Enter intact
            // instead of arriving as a plain Enter that "sends" where Enter
            // sends. Without it, Shift+Enter on iOS/Android submits the
            // message instead of inserting a newline. The listener lives on
            // the kept-alive view's contentDOM, so it stays across mounts and
            // keeps feeding the same ref the `interceptKeys` closure reads.
            const trackRealEnterShift = (event: KeyboardEvent) => {
                if (event.key !== 'Enter' || isDeferredSyntheticEvent(event)) return;
                lastRealEnterShiftRef.current = event.shiftKey;
            };
            view.contentDOM.addEventListener('keydown', trackRealEnterShift);

            return () => {
                viewRef.current = null;
                // A stored view is detached, not destroyed: the store owns its
                // lifetime now, and whoever owns the store ends it.
                if (store) {
                    view.dom.remove();
                    return;
                }
                view.destroy();
            };
            // Created once: every changing input is applied through a
            // dispatch below rather than by rebuilding the view.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // Controlled value: only write back when the prop and the document
        // genuinely differ, otherwise every keystroke would round-trip and
        // reset the caret.
        React.useEffect(() => {
            const view = viewRef.current;
            if (!view) return;
            const current = view.state.doc.toString();
            if (current === value) return;
            // Skip every controlled writeback while the browser is composing.
            // A stale value echo can differ from CodeMirror's newer document,
            // and replacing it would interrupt the IME session and move the caret.
            if (view.compositionStarted) return;
            view.dispatch({
                changes: { from: 0, to: current.length, insert: value },
                // An external rewrite (draft restore, history navigation,
                // "add to chat", dictation insert) lands the caret at the END,
                // matching what a plain textarea did when its value was
                // replaced. Every rewrite that reaches here appends or
                // replaces wholesale; keeping the old caret instead left it
                // stranded before the inserted text, and the next insertion
                // or keystroke landed inside the previous one.
                selection: { anchor: value.length },
            });
            // A large insert can push the caret below the fold, and a
            // transaction-time `scrollIntoView` cannot reach it: wrapped-line
            // heights are still estimates during the update, and the
            // grow-with-content effect applies the scroller's max-height cap
            // through a ResizeObserver a frame later — at scroll time the
            // overflow does not exist yet, so the scroller stays at the top.
            // The caret is at the end here, so once the layout has settled
            // (two frames: one for the cap, one after it) pin the scroller to
            // the bottom.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (viewRef.current !== view) return;
                    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
                });
            });
        }, [value]);

        React.useEffect(() => {
            viewRef.current?.dispatch({ effects: setLanguageContext.of(languageContext) });
        }, [languageContext]);

        React.useEffect(() => {
            viewRef.current?.dispatch({
                effects: editableCompartment.reconfigure(EditorView.editable.of(editable)),
            });
        }, [editable]);

        React.useEffect(() => {
            viewRef.current?.dispatch({
                effects: placeholderCompartment.reconfigure(placeholderExtension(placeholder ?? '')),
            });
        }, [placeholder]);

        // Grow with the content up to `maxLines`, then scroll. The limit is
        // measured from the rendered line height rather than assumed, so it
        // tracks the composer's responsive typography.
        React.useEffect(() => {
            const view = viewRef.current;
            const host = hostRef.current;
            if (!view || !host) return;

            // Filling the container means there is no line limit — and the
            // limit from the collapsed composer has to be released, or the
            // expanded editor keeps scrolling inside an invisible eight-line
            // window while the rest of the surface sits empty.
            if (fillContainer) {
                view.scrollDOM.style.maxHeight = '';
                return;
            }

            const boundEl = boundSelector ? host.closest(boundSelector) : null;
            // The bound's direct child our editor lives in: its height minus
            // the scroller's is exactly the chrome around the editor — form
            // paddings, model row, footer, attachment chips — measured live,
            // so the cap needs no estimate of what surrounds the editor.
            let branch: HTMLElement | null = null;
            if (boundEl) {
                branch = host;
                while (branch.parentElement && branch.parentElement !== boundEl) {
                    branch = branch.parentElement;
                }
            }

            const applyLimit = () => {
                const lineHeight = parseFloat(
                    getComputedStyle(view.contentDOM).lineHeight || '',
                );
                if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
                let cap = lineHeight * maxLines;
                if (boundEl && branch) {
                    const chrome = branch.offsetHeight - view.scrollDOM.offsetHeight;
                    const available = boundEl.clientHeight - chrome - boundGapPx;
                    if (available > 0) cap = Math.min(cap, available);
                }
                const next = `${cap}px`;
                // The scroller growing re-fires the observer with an unchanged
                // result; writing only on change keeps that loop silent.
                if (view.scrollDOM.style.maxHeight !== next) {
                    view.scrollDOM.style.maxHeight = next;
                }
            };

            applyLimit();
            if (typeof ResizeObserver === 'undefined') return;
            const observer = new ResizeObserver(applyLimit);
            observer.observe(host);
            if (branch) observer.observe(branch);
            if (boundEl) observer.observe(boundEl);
            return () => observer.disconnect();
        }, [boundGapPx, boundSelector, fillContainer, maxLines]);

        React.useEffect(() => {
            const view = viewRef.current;
            if (!view) return;
            const content = view.contentDOM;
            content.setAttribute('spellcheck', String(spellCheck));
            content.setAttribute('autocorrect', autoCorrect ? 'on' : 'off');
            content.setAttribute('autocapitalize', autoCapitalize);
        }, [autoCapitalize, autoCorrect, spellCheck]);

        /**
         * The composer box is bigger than its text: it carries padding, and in
         * focus mode it fills the surface. Clicking that empty space has always
         * put the caret in the text — with a textarea the element itself filled
         * the box, so the browser did it. CodeMirror's content element does not
         * extend into the padding, so the click has to be forwarded.
         */
        const handleHostMouseDown = React.useCallback((event: React.MouseEvent) => {
            handleComposerHostMouseDown(viewRef.current, event);
        }, []);

        React.useImperativeHandle(ref, (): ComposerEditorHandle => ({
            focus(options) {
                const view = viewRef.current;
                if (!view) return;
                // preventScroll matters on mobile, where the browser's own
                // scroll-into-view fights the keyboard choreography.
                view.contentDOM.focus({ preventScroll: options?.preventScroll });
            },
            blur() {
                viewRef.current?.contentDOM.blur();
            },
            isFocused() {
                return viewRef.current?.hasFocus ?? false;
            },
            getValue() {
                return viewRef.current?.state.doc.toString() ?? '';
            },
            getSelection() {
                const view = viewRef.current;
                return view ? readSelection(view.state) : { start: 0, end: 0 };
            },
            setSelection(start, end = start) {
                const view = viewRef.current;
                if (!view) return;
                const max = view.state.doc.length;
                view.dispatch({
                    selection: {
                        anchor: Math.min(Math.max(start, 0), max),
                        head: Math.min(Math.max(end, 0), max),
                    },
                });
            },
            selectAll() {
                const view = viewRef.current;
                if (!view) return;
                view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
            },
            insertText(text) {
                const view = viewRef.current;
                if (!view || !text) return;
                const { from, to } = view.state.selection.main;
                view.dispatch({
                    changes: { from, to, insert: text },
                    selection: { anchor: from + text.length },
                    userEvent: 'input.type',
                });
            },
            replaceRange(from, to, text, caret) {
                const view = viewRef.current;
                if (!view) return;
                view.dispatch({
                    changes: { from, to, insert: text },
                    selection: { anchor: caret ?? from + text.length },
                    userEvent: 'input.type',
                });
            },
            caretCoords(position) {
                const view = viewRef.current;
                if (!view) return null;
                const pos = position ?? view.state.selection.main.head;
                const coords = view.coordsAtPos(pos);
                return coords
                    ? { top: coords.top, bottom: coords.bottom, left: coords.left }
                    : null;
            },
            getScrollDOM() {
                return viewRef.current?.scrollDOM ?? null;
            },
        }), []);

        return (
            <div
                ref={hostRef}
                data-testid={props['data-testid']}
                data-chat-input="true"
                onMouseDown={handleHostMouseDown}
                className={cn(
                    'composer-editor w-full',
                    // The editor fills the host so its content box can cover
                    // the whole clickable area rather than just the text.
                    '[&_.cm-editor]:h-full',
                    fillContainer && 'flex min-h-0 flex-1 flex-col',
                    className,
                    contentClassName,
                )}
            />
        );
    },
);

function readSelection(state: EditorState): ComposerSelection {
    const range = state.selection.main;
    return { start: range.from, end: range.to };
}
