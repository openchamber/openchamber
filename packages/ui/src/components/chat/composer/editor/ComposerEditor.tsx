
import React from 'react';
import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import { Annotation, Compartment, EditorState, Prec, type ChangeDesc, type Extension } from '@codemirror/state';
import {
    EditorView,
    drawSelection,
    keymap,
    type KeyBinding,
} from '@codemirror/view';

import { createPortal } from 'react-dom';
import { PopupOverlayScrollbar } from '@/components/ui/AttachedOverlayScrollbar';
import { cn } from '@/lib/utils';
import type { ComposerLanguageContext } from '../language/tokenize';
import type { ComposerAutoCorrect } from './autocorrect';
import { composerLanguage, setLanguageContext } from './composerLanguage';
import { composerBidi } from './bidi';
import { replaceWithCaret } from './documentEdits';
import type { ComposerEditorViewStore } from './viewStore';
import { ComposerEditorView } from './ComposerEditorView';
import { composerEditorTheme, composerSelectionExtension, isCodeMirrorIOSNavigator } from './theme';
import { handleComposerHostMouseDown } from './hostMouseDown';
import { scriptAwareWordGestures } from './wordBoundaries';
import { getComposerHeightLimit, isComposerContentCapped } from './heightLimit';
import { imeNewlineCleanup } from './imeNewline';
import { restoreDeferredEnterModifiers } from '../keyboardPolicy';
import { timerCaretBlink } from '@/lib/codemirror/caretBlink';

export interface ComposerSelection {
    start: number;
    end: number;
}

export interface ComposerChange {
    value: string;
    selection: ComposerSelection;
    changes: ChangeDesc;
    fromPaste: boolean;
    insertedText: string;
    fromValueProp: boolean;
}

export interface ComposerEditorHandle {
    focus(options?: { preventScroll?: boolean }): void;
    blur(): void;
    isFocused(): boolean;
    getValue(): string;
    getSelection(): ComposerSelection;
    setSelection(start: number, end?: number): void;
    selectAll(): void;
    insertText(text: string): void;
    replaceRange(from: number, to: number, text: string, selectionStart?: number, selectionEnd?: number): void;
    caretCoords(position?: number): { top: number; bottom: number; left: number } | null;
    getScrollDOM(): HTMLElement | null;
}

export interface ComposerEditorProps {
    value: string;
    valueRevision?: number;
    onChange: (change: ComposerChange) => void;
    onSelectionChange?: (selection: ComposerSelection) => void;
    onKeyDown?: (event: KeyboardEvent) => boolean;
    onKeyUp?: (event: KeyboardEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onPaste?: (event: ClipboardEvent) => void;
    languageContext: ComposerLanguageContext;
    placeholder?: string;
    editable?: boolean;
    spellCheck?: boolean;
    returnKeySends?: boolean;
    autoCorrect?: ComposerAutoCorrect;
    autoCapitalize?: 'none' | 'sentences';
    preserveDeferredEnterShift?: boolean;
    fillContainer?: boolean;
    maxLines?: number;
    boundSelector?: string;
    boundGapPx?: number;
    className?: string;
    contentClassName?: string;
    dataChatInput?: string;
    scriptAwareWords?: boolean;
    viewStore?: ComposerEditorViewStore;
    'aria-label'?: string;
    'data-testid'?: string;
}

function insertedTextOf(transaction: { changes: { iterChanges: (fn: (fromA: number, toA: number, fromB: number, toB: number, inserted: { toString(): string }) => void) => void } }): string {
    let inserted = '';
    transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
        inserted += text.toString();
    });
    return inserted;
}

// external: https://code.haverbeke.berlin/codemirror/view/src/tag/6.43.15/src/input.ts Deferred synthetic key events carry no modifiers.
function isDeferredSyntheticEvent(event: KeyboardEvent): boolean {
    return Boolean((event as unknown as { synthetic?: boolean }).synthetic);
}

const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();
const enterKeyHintCompartment = new Compartment();

const enterKeyHintExtension = (send: boolean): Extension => {
    if (!send) return [];
    const nav = globalThis.navigator;
    return [
        EditorView.contentAttributes.of({ enterkeyhint: 'send' }),
        nav && isCodeMirrorIOSNavigator(nav.userAgent, nav.vendor, nav.maxTouchPoints)
            ? imeNewlineCleanup() : [],
    ];
};

const composerEmptyClass = EditorView.contentAttributes.of((view) =>
    view.state.doc.length === 0 ? { class: 'cm-composer-empty' } : null);

function placeholderContentAttributes(text: string) {
    return EditorView.contentAttributes.of({
        'aria-placeholder': text,
        style: `--composer-placeholder: ${JSON.stringify(text)}`,
    });
}

const valuePropWrite = Annotation.define<true>();

export const ComposerEditor = React.memo(React.forwardRef<ComposerEditorHandle, ComposerEditorProps>(
    function ComposerEditor(props, ref) {
        const {
            value,
            valueRevision,
            languageContext,
            placeholder,
            editable = true,
            spellCheck = false,
            returnKeySends = false,
            autoCorrect = 'off',
            autoCapitalize = 'none',
            fillContainer = false,
            maxLines = 8,
            boundSelector,
            boundGapPx = 0,
            className,
            contentClassName,
        } = props;

        const hostRef = React.useRef<HTMLDivElement | null>(null);
        const [mountedView, setMountedView] = React.useState<EditorView | null>(null);
        const viewRef = React.useRef<EditorView | null>(null);

        const lastRealEnterModsRef = React.useRef({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
        const deferredEnterModsTimeoutRef = React.useRef<number | null>(null);
        const clearDeferredEnterModifiers = () => {
            lastRealEnterModsRef.current = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
            if (deferredEnterModsTimeoutRef.current !== null) {
                window.clearTimeout(deferredEnterModsTimeoutRef.current);
                deferredEnterModsTimeoutRef.current = null;
            }
        };

        const localHandlersRef = React.useRef(props);
        const store = props.viewStore ?? null;
        if (store && !store.handlers) store.handlers = { current: props };
        const handlersRef = store?.handlers ?? localHandlersRef;
        handlersRef.current = props;

        React.useLayoutEffect(() => {
            const host = hostRef.current;
            if (!host) return;

            const keptView = store?.view;
            if (keptView) {
                host.appendChild(keptView.dom);
                keptView.requestMeasure();
                viewRef.current = keptView;
                setMountedView(keptView);
                return () => {
                    keptView.dom.remove();
                    viewRef.current = null;
                    setMountedView(null);
                };
            }

            const interceptKeys: KeyBinding[] = [{
                any: (_view, event) => {
                    if (event.key === 'Enter' && isDeferredSyntheticEvent(event)) {
                        const preserveShift = handlersRef.current.preserveDeferredEnterShift !== false;
                        restoreDeferredEnterModifiers(event, lastRealEnterModsRef.current, preserveShift);
                        clearDeferredEnterModifiers();
                    }
                    return handlersRef.current.onKeyDown?.(event) ?? false;
                },
            }];

            const view = new ComposerEditorView({
                state: EditorState.create({
                    doc: handlersRef.current.value,
                    extensions: [
                        history(),
                        drawSelection(),
                        timerCaretBlink(),
                        composerSelectionExtension(),
                        EditorView.lineWrapping,
                        Prec.highest(keymap.of(interceptKeys)),
                        handlersRef.current.scriptAwareWords ? scriptAwareWordGestures : [],
                        keymap.of([
                            { key: 'Alt-Enter', run: insertNewline },
                            // external: https://code.haverbeke.berlin/codemirror/view/src/tag/6.43.15/src/input.ts Native page movement can scroll hidden-overflow ancestors when a boundary command yields.
                            ...standardKeymap.map((binding) =>
                                binding.key === 'PageUp' || binding.key === 'PageDown'
                                    ? { ...binding, preventDefault: true }
                                    : binding),
                            ...historyKeymap,
                        ]),
                        composerLanguage(handlersRef.current.languageContext),
                        composerBidi,
                        editableCompartment.of(
                            EditorView.editable.of(handlersRef.current.editable ?? true),
                        ),
                        composerEmptyClass,
                        enterKeyHintCompartment.of(
                            enterKeyHintExtension(handlersRef.current.returnKeySends === true),
                        ),
                        placeholderCompartment.of(
                            placeholderContentAttributes(handlersRef.current.placeholder ?? ''),
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
                                    changes: update.changes,
                                    fromPaste,
                                    insertedText,
                                    fromValueProp: update.transactions.every(
                                        (transaction) => !transaction.docChanged || transaction.annotation(valuePropWrite) === true,
                                    ),
                                });
                                return;
                            }

                            if (update.selectionSet) {
                                handlers.onSelectionChange?.(selection);
                            }
                        }),
                        EditorView.domEventHandlers({
                            keyup: (event) => { handlersRef.current.onKeyUp?.(event); return false; },
                            focus: () => { handlersRef.current.onFocus?.(); return false; },
                            blur: () => { handlersRef.current.onBlur?.(); return false; },
                            paste: (event) => { handlersRef.current.onPaste?.(event); return false; },
                        }),
                        EditorView.contentAttributes.of({
                            spellcheck: String(handlersRef.current.spellCheck ?? false),
                            autocorrect: handlersRef.current.autoCorrect ?? 'off',
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
            setMountedView(view);
            if (store) store.view = view;

            const trackRealEnterMods = (event: KeyboardEvent) => {
                if (event.key !== 'Enter' || isDeferredSyntheticEvent(event)) return;
                clearDeferredEnterModifiers();
                lastRealEnterModsRef.current = {
                    shiftKey: event.shiftKey,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    altKey: event.altKey,
                };
                deferredEnterModsTimeoutRef.current = window.setTimeout(clearDeferredEnterModifiers, 500);
            };
            view.contentDOM.addEventListener('keydown', trackRealEnterMods);

            return () => {
                clearDeferredEnterModifiers();
                viewRef.current = null;
                setMountedView(null);
                if (store) {
                    view.dom.remove();
                    return;
                }
                view.destroy();
            };
            // oxlint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        React.useEffect(() => {
            const view = viewRef.current;
            if (!view) return;
            const current = view.state.doc.toString();
            if (current === value) return;
            if (view.compositionStarted) return;
            view.dispatch({
                ...replaceWithCaret(view.state, 0, current.length, value),
                annotations: valuePropWrite.of(true),
            });
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (viewRef.current !== view) return;
                    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
                });
            });
        }, [value, valueRevision]);

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
                effects: placeholderCompartment.reconfigure(
                    placeholderContentAttributes(placeholder ?? ''),
                ),
            });
        }, [placeholder]);

        React.useEffect(() => {
            viewRef.current?.dispatch({
                effects: enterKeyHintCompartment.reconfigure(enterKeyHintExtension(returnKeySends === true)),
            });
        }, [returnKeySends]);

        React.useEffect(() => {
            const view = viewRef.current;
            const host = hostRef.current;
            if (!view || !host) return;

            if (fillContainer) {
                view.scrollDOM.style.maxHeight = '';
                view.scrollDOM.style.overflowY = '';
                return;
            }

            const boundEl = boundSelector ? host.closest(boundSelector) : null;
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
                const cap = getComposerHeightLimit({
                    maxLinesHeight: lineHeight * maxLines,
                    boundHeight: boundEl?.clientHeight,
                    surroundingHeight: branch
                        ? branch.offsetHeight - view.scrollDOM.offsetHeight
                        : undefined,
                    boundGapPx,
                });
                const next = `${cap}px`;
                if (view.scrollDOM.style.maxHeight !== next) {
                    view.scrollDOM.style.maxHeight = next;
                }
                const overflowY = isComposerContentCapped(
                    view.contentDOM.getBoundingClientRect().height,
                    cap,
                    lineHeight,
                ) ? 'auto' : 'hidden';
                if (view.scrollDOM.style.overflowY !== overflowY) {
                    view.scrollDOM.style.overflowY = overflowY;
                }
            };

            applyLimit();
            if (typeof ResizeObserver === 'undefined') return;
            const observer = new ResizeObserver(applyLimit);
            observer.observe(host);
            observer.observe(view.contentDOM);
            if (branch) observer.observe(branch);
            if (boundEl) observer.observe(boundEl);
            return () => observer.disconnect();
        }, [boundGapPx, boundSelector, fillContainer, maxLines]);

        React.useEffect(() => {
            const view = viewRef.current;
            if (!view) return;
            const content = view.contentDOM;
            content.setAttribute('spellcheck', String(spellCheck));
            content.setAttribute('autocorrect', autoCorrect);
            content.setAttribute('autocapitalize', autoCapitalize);
        }, [autoCapitalize, autoCorrect, spellCheck]);

        const handleHostMouseDown = React.useCallback((event: React.MouseEvent) => {
            handleComposerHostMouseDown(viewRef.current, event);
        }, []);

        React.useImperativeHandle(ref, (): ComposerEditorHandle => ({
            focus(options) {
                const view = viewRef.current;
                if (!view) return;
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
                    ...replaceWithCaret(view.state, from, to, text),
                    userEvent: 'input.type',
                });
            },
            replaceRange(from, to, text, selectionStart, selectionEnd = selectionStart) {
                const view = viewRef.current;
                if (!view) return;
                const caret = selectionStart === undefined
                    ? undefined
                    : { anchor: selectionStart, head: selectionEnd ?? selectionStart };
                view.dispatch({
                    ...replaceWithCaret(view.state, from, to, text, caret),
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
            <>
                <div
                    ref={hostRef}
                    data-testid={props['data-testid']}
                    data-chat-input={props.dataChatInput ?? 'true'}
                    onMouseDown={handleHostMouseDown}
                    className={cn(
                        'composer-editor w-full',
                        '[&_.cm-editor]:h-full',
                        fillContainer && 'flex min-h-0 flex-1 flex-col',
                        className,
                        contentClassName,
                    )}
                />
                {mountedView ? createPortal(
                    <PopupOverlayScrollbar scroller={mountedView.scrollDOM} disableHorizontal />,
                    mountedView.dom,
                ) : null}
            </>
        );
    },
));

function readSelection(state: EditorState): ComposerSelection {
    const range = state.selection.main;
    return { start: range.from, end: range.to };
}
