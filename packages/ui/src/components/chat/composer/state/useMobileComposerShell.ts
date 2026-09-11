/**
 * The mobile composer's pill ↔ full-composer state machine.
 *
 * With the keyboard closed the composer collapses into a narrow pill; any
 * interaction expands it back. The swap is deliberately instant and
 * synchronized with the keyboard choreography, so the chat compensates
 * keyboard and composer height in a single motion rather than a staircase.
 *
 * Most of the code here is not the state machine itself but the corrections
 * that keep it from fighting the platform: mobile browsers dismiss the
 * keyboard on a tap before the click lands, iOS refuses programmatic focus
 * outside a gesture, WebKit leaves the layout viewport panned after the
 * keyboard hides, and overlay chains hand off through a frame where nothing
 * is open. Every timeout and flushSync below marks one of those, and none of
 * them is verifiable outside a real device.
 */

import React from 'react';
import { flushSync } from 'react-dom';

import { observeEditorFocus } from '@/lib/hardwareKeyboard';
import { isCapacitorApp } from '@/lib/platform';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';

/**
 * Everything that must keep the composer expanded even with the keyboard
 * down. Collapsing under an open sheet would unmount the focused editor and
 * kill the keyboard the sheet is about to hand back.
 */
export interface MobileComposerHolders {
    controlsPanelOpen: boolean;
    attachMenuOpen: boolean;
    draftPickerOpen: boolean;
    issuePickerOpen: boolean;
    prPickerOpen: boolean;
    linearPickerOpen: boolean;
    isDragging: boolean;
}

export interface MobileComposerShellOptions {
    isMobile: boolean;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
    formRef: React.RefObject<HTMLFormElement | null>;
    setExpandedInput: (expanded: boolean) => void;
    holders: MobileComposerHolders;
    /**
     * Keep the full composer up permanently and never fall back to the pill.
     * The pill exists to buy screen back from the soft keyboard; with a
     * hardware keyboard on a tablet there is no soft keyboard to hide from,
     * and collapsing between keystrokes would only cost the user a tap.
     */
    alwaysExpanded?: boolean;
}

export interface MobileComposerShell {
    /** The full composer is showing rather than the collapsed pill. */
    expanded: boolean;
    /** The editor has focus; the best keyboard proxy a browser offers. */
    focused: boolean;
    /** A MobileOverlayPanel is mounted in the shared portal root. */
    overlayHostBusy: boolean;
    dictationActive: boolean;
    /** Expand and focus, synchronously, from inside a user gesture. */
    expand: () => void;
    onDictationActiveChange: (active: boolean) => void;
    onEditorFocus: () => void;
    onEditorBlur: () => void;
    /** Suppress the keyboard restore when another overlay opens next. */
    skipNextOverlayCloseRestore: () => void;
    /** Cancel a pending keyboard restore entirely (a native picker takes over). */
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

    // Set while an expansion is settling (focus or dictation not yet active) so
    // the collapse watcher does not immediately fold it back into the pill.
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

    // A hardware keyboard can be attached (or detached) at any moment, so this
    // is a live condition rather than a mount-time one. Detaching does NOT
    // force a collapse — the normal idle/keyboard-hide paths take over again.
    const alwaysExpandedRef = React.useRef(alwaysExpanded);
    alwaysExpandedRef.current = alwaysExpanded;
    React.useEffect(() => {
        if (!isMobile || !alwaysExpanded) return;
        setExpanded(true);
    }, [alwaysExpanded, isMobile]);

    // The draft screen restructures itself around the composer: its starter
    // chips leave once the full composer is up, and its centered title
    // re-centers over whatever room remains. Announced as a root class from a
    // layout effect so the restructure lands in the SAME frame as the pill
    // swap — keyed on the keyboard instead (oc-keyboard-open arrives with the
    // keyboardWillShow bridge event, ~100ms later), the chips vanished
    // mid-rise as a second visible jump.
    //
    // Not announced while `alwaysExpanded`: there the full composer is the
    // resting state, not a keyboard takeover, so claiming otherwise would hide
    // the starters permanently. The keyboard classes still cover that case.
    React.useLayoutEffect(() => {
        if (!isMobile || typeof document === 'undefined') return;
        const root = document.documentElement;
        root.classList.toggle('oc-composer-expanded', expanded && !alwaysExpanded);
        return () => root.classList.remove('oc-composer-expanded');
    }, [alwaysExpanded, expanded, isMobile]);

    const expand = React.useCallback(() => {
        expandIntentRef.current = 'focus';
        // flushSync so the editor exists NOW and focus() still runs inside the
        // gesture's call stack: mobile browsers only open the soft keyboard for
        // focus calls made synchronously from the tap (an rAF here worked in
        // the Capacitor WebView but not in Safari or Chrome).
        flushSync(() => setExpanded(true));

        if (isCapacitorApp()) {
            // Timing tuned on device, against WKWebView pausing frame
            // presentation while the keyboard transition runs:
            //  - focus in the same task as the swap → the pause starts before
            //    the swap's first frame, so the pill stays on glass until the
            //    keyboard is nearly up;
            //  - focus two frames later → the swap is presented first and the
            //    keyboard only then begins, a visibly sequential two-step.
            // Focusing INSIDE the first frame after the commit threads the
            // needle: the swap's frame is already in the rendering pipeline
            // when the keyboard transaction starts, so the keyboard rises from
            // the tap and the composer appears during the rise. The Capacitor
            // WebView raises the keyboard for a focus() outside the gesture
            // task (browsers do not, hence the split); the choreography
            // positions everything, so preventScroll stays on.
            requestAnimationFrame(() => {
                editorRef.current?.focus({ preventScroll: true });
            });
            return;
        }

        // Mobile browsers only open the soft keyboard for focus calls made
        // synchronously from the tap; their native reveal is also the only
        // thing that positions the composer, so no preventScroll.
        editorRef.current?.focus({ preventScroll: false });
    }, [editorRef]);

    const onDictationActiveChange = React.useCallback((active: boolean) => {
        setDictationActive(active);
        if (active) {
            expandIntentRef.current = null;
            // Dictation went live, possibly from the pill: switch straight into
            // the voice variant of the full composer.
            if (!expandedRef.current) setExpanded(true);
            return;
        }
        // Dictation ended. The insert flow hands focus back a tick later — if
        // that happened, stay expanded; otherwise (cancel, discard,
        // insert-and-send) collapse straight back to the pill rather than
        // parking on the normal composer for the usual grace period.
        window.setTimeout(() => {
            if (!expandedRef.current || alwaysExpandedRef.current) return;
            if (editorRef.current?.isFocused()) return;
            setExpanded(false);
            setExpandedInput(false);
        }, 30);
    }, [editorRef, setExpandedInput]);

    // Watch the shared overlay portal root: any mounted MobileOverlayPanel
    // counts as busy. Observing the host catches overlays whose open state
    // lives in other components without threading it through here.
    React.useEffect(() => {
        if (!isMobile || typeof document === 'undefined') return;
        let host = document.getElementById('mobile-overlay-root');
        if (!host) {
            // Same lazy-create contract as MobileOverlayPanel's ensureOverlayRoot.
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
        || holders.issuePickerOpen
        || holders.prPickerOpen
        || holders.linearPickerOpen;

    // Installed PWA (standalone): a focus() from a bare timeout is outside the
    // user gesture and iOS refuses to raise the keyboard for it (Safari
    // in-browser is lenient). MobileOverlayPanel dispatches
    // 'oc:mobile-overlay-closed' synchronously from the same React flush as the
    // click that closed it — refocus right there, while the gesture is live.
    const pickerDialogsOpenRef = React.useRef(false);
    pickerDialogsOpenRef.current = holders.issuePickerOpen || holders.prPickerOpen || holders.linearPickerOpen;
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
            // Counter instead of a DOM check: the close event fires from a
            // layout-effect cleanup, when the closing sheet's portal nodes may
            // still be attached — the DOM cannot tell "this sheet going away"
            // from "another sheet still up".
            openSheetCountRef.current = Math.max(0, openSheetCountRef.current - 1);
            if (skipNextCloseRestoreRef.current) {
                skipNextCloseRestoreRef.current = false;
                return;
            }
            if (!restoreKeyboardRef.current) return;
            if (pickerDialogsOpenRef.current) return;
            if (openSheetCountRef.current > 0) return;
            restoreKeyboardRef.current = false;

            // iOS can still dismiss the freshly-raised keyboard when the tap
            // that closed the overlay finishes over non-input content — hold
            // focus through that window (see onEditorBlur).
            holdFocusUntilRef.current = Date.now() + 600;
            editorRef.current?.focus();
            // The native focus lands mid-commit; React's delegated onFocus may
            // not make it into this flush, leaving the composer un-busy for a
            // beat — enough for the collapse timer to unmount the focused
            // editor and kill the rising keyboard. Set the state explicitly.
            if (editorRef.current?.isFocused()) setFocused(true);

            // iOS reveals a field above the keyboard only for user-initiated
            // focus; a programmatic one leaves the composer parked behind it.
            // Reveal once the keyboard has mostly risen, and again after it
            // settles.
            const reveal = () => {
                const editor = editorRef.current;
                if (!editor?.isFocused()) return;
                // Align the BOTTOM of the whole form with the visible bottom:
                // revealing the editor alone leaves the footer icon row parked
                // behind the keyboard accessory bar.
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

    // If the keyboard was open (or closed moments ago by the overlay's own
    // blur) when an overlay appeared, bring it back once every overlay is gone.
    React.useEffect(() => {
        if (!isMobile) return;
        if (overlayOpen) {
            if (focused || Date.now() - lastBlurAtRef.current < 800) {
                restoreKeyboardRef.current = true;
            }
            return;
        }
        if (!restoreKeyboardRef.current) return;
        // Debounced: overlay chains hand off with a frame of "nothing open"
        // between steps (attach sheet closes, then the picker opens). Restoring
        // instantly in that gap would pop the keyboard open inside the next
        // overlay — wait out the gap and cancel if another overlay appears.
        const timer = window.setTimeout(() => {
            restoreKeyboardRef.current = false;
            // Browsers need their native scroll-into-view (see expand).
            editorRef.current?.focus({ preventScroll: isCapacitorApp() });
        }, 180);
        return () => window.clearTimeout(timer);
    }, [editorRef, focused, isMobile, overlayOpen]);

    // Fold back into the pill once nothing keeps the composer open. The short
    // delay bridges focus moving between composer controls.
    const busy = focused
        || overlayHostBusy
        || dictationActive
        || holders.controlsPanelOpen
        || holders.attachMenuOpen
        || holders.draftPickerOpen
        || holders.issuePickerOpen
        || holders.prPickerOpen
        || holders.linearPickerOpen
        || holders.isDragging;

    React.useEffect(() => {
        if (!isMobile || !expanded || busy || alwaysExpanded) return;
        const timer = window.setTimeout(() => {
            // Authoritative DOM check: the React focus state can lag a
            // programmatic refocus (the overlay-close restore above).
            // Collapsing would unmount the focused editor and kill the keyboard.
            if (editorRef.current?.isFocused()) return;
            expandIntentRef.current = null;
            setExpanded(false);
            setExpandedInput(false);
        }, 250);
        return () => window.clearTimeout(timer);
    }, [alwaysExpanded, busy, editorRef, expanded, isMobile, setExpandedInput]);

    const busyRef = React.useRef(false);
    busyRef.current = busy;

    // Browser counterpart of Capacitor's oc-keyboard-open root class (which is
    // driven by native keyboard events): the focused composer is the best
    // keyboard proxy a browser has. CSS keyed on it hides the draft starters
    // while typing, mirroring the native app.
    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof document === 'undefined') return;
        const root = document.documentElement;
        if (focused) {
            root.classList.add('oc-browser-keyboard-open');
        } else {
            root.classList.remove('oc-browser-keyboard-open');
            // Installed PWA: after the keyboard dismisses, WebKit can leave the
            // layout viewport stuck smaller or panned (content shifted up with
            // a dead strip at the bottom) until something forces a recompute. A
            // zero scroll after the exit animation settles snaps it back, and
            // is harmless when nothing is stuck.
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

    // Capacitor: collapse in the SAME frame the keyboard starts hiding. The
    // hide choreography dispatches oc:keyboard-intent BEFORE restoring the
    // shell layout and measuring the chat compensation; flushSync commits the
    // pill swap first, so keyboard land and composer shrink are measured — and
    // compensated — as one motion instead of a two-step staircase. The delayed
    // effect above remains the fallback for non-Capacitor and for overlays
    // closing without a keyboard transition.
    React.useEffect(() => {
        if (!isMobile || typeof window === 'undefined') return;
        const handleIntent = (event: Event) => {
            const detail = (event as CustomEvent<{ open?: boolean }>).detail;
            if (!detail || detail.open !== false) return;
            if (!expandedRef.current || alwaysExpandedRef.current) return;
            // Something still holds the composer open (dictation, an overlay
            // that closed the keyboard, a drag) — the fallback path handles it.
            if (busyRef.current) return;
            expandIntentRef.current = null;
            flushSync(() => {
                setExpanded(false);
                setExpandedInput(false);
            });
        };
        window.addEventListener('oc:keyboard-intent', handleIntent);
        return () => window.removeEventListener('oc:keyboard-intent', handleIntent);
    }, [isMobile, setExpandedInput]);

    const onEditorFocus = React.useCallback(() => {
        if (!isMobile) return;
        // Focus is the only moment a soft keyboard would be presented, so it is
        // also the only moment its ABSENCE tells us a hardware one is attached.
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

        // Focus hold after an overlay-close restore: iOS may retract the rising
        // keyboard as the closing tap settles — take the focus right back
        // instead of accepting the blur.
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

        // Mobile browsers and installed PWAs share a blur race: the
        // keyboard-dismiss reflow moves composer buttons before the tap's
        // synthesized click lands, so the click misses its target. Capacitor's
        // WebView does not need the hold — but it DOES need the state committed
        // synchronously: the oc:keyboard-intent collapse arrives a few
        // milliseconds after this blur on a setTimeout(0), and React's own
        // scheduling can lose that race, leaving busyRef stale — the intent
        // handler then skips the instant collapse and the pill appears only
        // via the 250ms fallback, well after the keyboard has gone.
        if (isCapacitorApp()) {
            flushSync(() => setFocused(false));
            return;
        }
        if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
        // 120ms outlives the tap's synthesized click (which lands within a few
        // ms of the blur) while keeping the composer's return visually tied to
        // the keyboard dismissal.
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

    return {
        expanded,
        focused,
        overlayHostBusy,
        dictationActive,
        expand,
        onDictationActiveChange,
        onEditorFocus,
        onEditorBlur,
        skipNextOverlayCloseRestore,
        cancelOverlayCloseRestore,
    };
}
