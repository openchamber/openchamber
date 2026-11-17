
import React from 'react';
import { flushSync } from 'react-dom';

import { observeEditorFocus } from '@/lib/hardwareKeyboard';
import { isCapacitorApp } from '@/lib/platform';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';
import { createComposerMorphController, type ComposerMorphController } from './mobileComposerMorph';

interface MobileComposerHolders {
    controlsPanelOpen: boolean;
    attachMenuOpen: boolean;
    draftPickerOpen: boolean;
    referencePickerOpen: boolean;
    promptHistorySearchOpen: boolean;
    isDragging: boolean;
}

export interface MobileComposerShellOptions {
    isMobile: boolean;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
    formRef: React.RefObject<HTMLFormElement | null>;
    setExpandedInput: (expanded: boolean) => void;
    holders: MobileComposerHolders;
    alwaysExpanded?: boolean;
}

export interface MobileComposerShell {
    expanded: boolean;
    focused: boolean;
    overlayHostBusy: boolean;
    dictationActive: boolean;
    expand: () => void;
    onDictationActiveChange: (active: boolean) => void;
    holdDictationSend: (held: boolean) => void;
    onEditorFocus: () => void;
    onEditorBlur: () => void;
    skipNextOverlayCloseRestore: () => void;
    cancelOverlayCloseRestore: () => void;
}

export function useMobileComposerShell(
    options: MobileComposerShellOptions,
): MobileComposerShell {
    const { isMobile, editorRef, formRef, setExpandedInput, holders, alwaysExpanded = false } = options;

    const [expanded, setExpanded] = React.useState(alwaysExpanded && isMobile);
    const [focused, setFocused] = React.useState(false);
    const [overlayHostBusy, setOverlayHostBusy] = React.useState(false);
    const [dictationActive, setDictationActive] = React.useState(false);
    const [dictationSendHeld, setDictationSendHeld] = React.useState(false);

    const expandIntentRef = React.useRef<'focus' | null>(null);
    const lastBlurAtRef = React.useRef(0);
    const restoreKeyboardRef = React.useRef(false);
    const blurTimerRef = React.useRef<number | null>(null);

    React.useEffect(() => () => {
        if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
    }, []);

    const expandedRef = React.useRef(expanded);
    React.useEffect(() => {
        expandedRef.current = expanded;
    });

    const morphRef = React.useRef<ComposerMorphController | null>(null);
    if (morphRef.current === null) morphRef.current = createComposerMorphController();
    const morph = morphRef.current;
    React.useEffect(() => () => morph.cancel(), [morph]);

    const alwaysExpandedRef = React.useRef(alwaysExpanded);
    alwaysExpandedRef.current = alwaysExpanded;
    React.useEffect(() => {
        if (!isMobile || !alwaysExpanded) return;
        setExpanded(true);
    }, [alwaysExpanded, isMobile]);

    React.useLayoutEffect(() => {
        if (!isMobile || typeof document === 'undefined') return;
        const root = document.documentElement;
        root.classList.toggle('oc-composer-expanded', expanded && !alwaysExpanded);
        return () => root.classList.remove('oc-composer-expanded');
    }, [alwaysExpanded, expanded, isMobile]);

    const expand = React.useCallback(() => {
        expandIntentRef.current = 'focus';
        morph.run('expand', formRef.current, () => {
            flushSync(() => setExpanded(true));
        });

        if (isCapacitorApp()) {
            requestAnimationFrame(() => {
                editorRef.current?.focus({ preventScroll: true });
            });
            return;
        }

        editorRef.current?.focus({ preventScroll: false });
    }, [editorRef, formRef, morph]);

    const onDictationActiveChange = React.useCallback((active: boolean) => {
        setDictationActive(active);
        if (active) {
            expandIntentRef.current = null;
            if (!expandedRef.current) setExpanded(true);
            return;
        }
        window.setTimeout(() => {
            if (!expandedRef.current || alwaysExpandedRef.current) return;
            if (dictationSendHeldRef.current) return;
            if (editorRef.current?.isFocused()) return;
            setExpanded(false);
            setExpandedInput(false);
        }, 30);
    }, [editorRef, setExpandedInput]);

    const dictationSendHeldRef = React.useRef(false);
    const holdDictationSend = React.useCallback((held: boolean) => {
        dictationSendHeldRef.current = held;
        setDictationSendHeld(held);
    }, []);

    React.useEffect(() => {
        if (!isMobile || typeof document === 'undefined') return;
        let host = document.getElementById('mobile-overlay-root');
        if (!host) {
            host = document.createElement('div');
            host.id = 'mobile-overlay-root';
            document.body.appendChild(host);
        }
        const hostEl = host;
        const update = () => setOverlayHostBusy(hostEl.childElementCount > 0);
        update();
        const observer = new MutationObserver(update);
        observer.observe(hostEl, { childList: true });
        return () => observer.disconnect();
    }, [isMobile]);

    const overlayOpen = overlayHostBusy
        || holders.controlsPanelOpen
        || holders.attachMenuOpen
        || holders.referencePickerOpen;

    const pickerDialogsOpenRef = React.useRef(false);
    pickerDialogsOpenRef.current = holders.referencePickerOpen;
    const skipNextCloseRestoreRef = React.useRef(false);
    const openSheetCountRef = React.useRef(0);
    const holdFocusUntilRef = React.useRef(0);

    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof window === 'undefined') return;
        if (!window.matchMedia?.('(display-mode: standalone)')?.matches) return;

        const handleOverlayOpened = () => {
            openSheetCountRef.current += 1;
        };
        const handleOverlayClosed = () => {
            openSheetCountRef.current = Math.max(0, openSheetCountRef.current - 1);
            if (skipNextCloseRestoreRef.current) {
                skipNextCloseRestoreRef.current = false;
                return;
            }
            if (!restoreKeyboardRef.current) return;
            if (pickerDialogsOpenRef.current) return;
            if (openSheetCountRef.current > 0) return;
            restoreKeyboardRef.current = false;

            holdFocusUntilRef.current = Date.now() + 600;
            editorRef.current?.focus();
            if (editorRef.current?.isFocused()) setFocused(true);

            const reveal = () => {
                const editor = editorRef.current;
                if (!editor?.isFocused()) return;
                (formRef.current ?? editor.getScrollDOM())?.scrollIntoView({ block: 'end' });
            };
            window.setTimeout(reveal, 300);
            window.setTimeout(reveal, 650);
        };

        window.addEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
        window.addEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        return () => {
            window.removeEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
            window.removeEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        };
    }, [editorRef, formRef, isMobile]);

    React.useEffect(() => {
        if (!isMobile) return;
        if (overlayOpen) {
            if (focused || Date.now() - lastBlurAtRef.current < 800) {
                restoreKeyboardRef.current = true;
            }
            return;
        }
        if (!restoreKeyboardRef.current) return;
        const timer = window.setTimeout(() => {
            restoreKeyboardRef.current = false;
            editorRef.current?.focus({ preventScroll: isCapacitorApp() });
        }, 180);
        return () => window.clearTimeout(timer);
    }, [editorRef, focused, isMobile, overlayOpen]);

    const busy = focused
        || overlayHostBusy
        || dictationActive
        || dictationSendHeld
        || holders.controlsPanelOpen
        || holders.attachMenuOpen
        || holders.draftPickerOpen
        || holders.referencePickerOpen
        || holders.promptHistorySearchOpen
        || holders.isDragging;

    React.useEffect(() => {
        if (!isMobile || !expanded || busy || alwaysExpanded) return;
        const timer = window.setTimeout(() => {
            if (editorRef.current?.isFocused()) return;
            expandIntentRef.current = null;
            setExpanded(false);
            setExpandedInput(false);
        }, 250);
        return () => window.clearTimeout(timer);
    }, [alwaysExpanded, busy, editorRef, expanded, isMobile, setExpandedInput]);

    const busyRef = React.useRef(false);
    busyRef.current = busy;

    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof document === 'undefined') return;
        const root = document.documentElement;
        if (focused) {
            root.classList.add('oc-browser-keyboard-open');
        } else {
            root.classList.remove('oc-browser-keyboard-open');
            if (window.matchMedia?.('(display-mode: standalone)')?.matches) {
                window.setTimeout(() => {
                    if (root.classList.contains('oc-browser-keyboard-open')) return;
                    window.scrollTo(0, 0);
                    document.body.scrollTop = 0;
                    root.scrollTop = 0;
                }, 350);
            }
        }
        return () => root.classList.remove('oc-browser-keyboard-open');
    }, [focused, isMobile]);

    React.useEffect(() => {
        if (!isMobile || typeof window === 'undefined') return;
        const handleIntent = (event: Event) => {
            const detail = (event as CustomEvent<{ open?: boolean }>).detail;
            if (!detail || detail.open !== false) return;
            if (!expandedRef.current || alwaysExpandedRef.current) return;
            if (busyRef.current) return;
            expandIntentRef.current = null;
            morph.run('collapse', formRef.current, () => {
                flushSync(() => {
                    setExpanded(false);
                    setExpandedInput(false);
                });
            });
        };
        window.addEventListener('oc:keyboard-intent', handleIntent);
        return () => window.removeEventListener('oc:keyboard-intent', handleIntent);
    }, [formRef, isMobile, morph, setExpandedInput]);

    const onEditorFocus = React.useCallback(() => {
        if (!isMobile) return;
        if (isCapacitorApp()) observeEditorFocus();
        if (blurTimerRef.current !== null) {
            window.clearTimeout(blurTimerRef.current);
            blurTimerRef.current = null;
        }
        expandIntentRef.current = null;
        setFocused(true);
    }, [isMobile]);

    const onEditorBlur = React.useCallback(() => {
        if (!isMobile) return;

        if (Date.now() < holdFocusUntilRef.current) {
            const editor = editorRef.current;
            if (editor) {
                editor.focus();
                window.setTimeout(() => {
                    if (Date.now() < holdFocusUntilRef.current && !editor.isFocused()) {
                        editor.focus();
                    }
                }, 50);
                return;
            }
        }

        lastBlurAtRef.current = Date.now();

        if (isCapacitorApp()) {
            flushSync(() => setFocused(false));
            return;
        }
        if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = null;
            setFocused(false);
        }, 120);
    }, [editorRef, isMobile]);

    const skipNextOverlayCloseRestore = React.useCallback(() => {
        skipNextCloseRestoreRef.current = true;
    }, []);

    const cancelOverlayCloseRestore = React.useCallback(() => {
        restoreKeyboardRef.current = false;
    }, []);

    return React.useMemo(() => ({
        expanded,
        focused,
        overlayHostBusy,
        dictationActive,
        expand,
        onDictationActiveChange,
        holdDictationSend,
        onEditorFocus,
        onEditorBlur,
        skipNextOverlayCloseRestore,
        cancelOverlayCloseRestore,
    }), [
        expanded,
        focused,
        overlayHostBusy,
        dictationActive,
        expand,
        onDictationActiveChange,
        holdDictationSend,
        onEditorFocus,
        onEditorBlur,
        skipNextOverlayCloseRestore,
        cancelOverlayCloseRestore,
    ]);
}
