/**
 * Pinning the composer to the visual viewport in mobile browsers.
 *
 * Capacitor has a keyboard choreography that resizes the shell, so the
 * composer stays where it belongs on its own. A mobile browser has nothing of
 * the sort: Safari pans the visual viewport over an unchanged layout instead
 * of shrinking it, so a composer positioned in normal flow ends up partly
 * off-screen or behind the keyboard. Every effect here exists to put it back,
 * and all are deliberately restricted to non-Capacitor mobile browsers — the
 * last one to the iPad Home Screen app, at any width.
 *
 * The WebKit behaviors they correct are only verifiable on a device, and every
 * guard in them marks a case that was observed breaking; tests cover only the
 * iPad lift's arithmetic.
 */

import React from 'react';

import { isCapacitorApp, isIPadDevice } from '@/lib/platform';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';

// Android mobile browsers are the pan-mode holdouts this pin exists for on
// the CHAT screen too: interactive-widget=resizes-content is ignored by a
// fair share of Android WebView/Chrome builds, and unlike iOS Safari they do
// not reliably reveal the focused field either — the composer just stays
// behind the keyboard. iOS keeps its browser-native reveal on the chat
// screen, so this stays Android-only there.
// Callers are browser-only React effects, so navigator always exists here.
const isAndroidBrowser = (): boolean => /Android/i.test(navigator.userAgent);

// The iPad Home Screen app is the iOS exception: standalone Safari neither
// resizes the page nor reveals the focused field, and a keyboard shown again
// after a dismissal fires no visualViewport resize, so the composer stayed
// behind it until the first keystroke (#4326).
const isIPadHomeScreenApp = (): boolean => (
    isIPadDevice() && window.matchMedia?.('(display-mode: standalone)').matches === true
);

export interface MobileViewportPinOptions {
    isMobile: boolean;
    /** Composer expanded to fullscreen on mobile. */
    isFullscreen: boolean;
    /** The new-session draft screen is showing. */
    isDraftScreen: boolean;
    /** The composer has focus, i.e. the keyboard is up. */
    isFocused: boolean;
    formRef: React.RefObject<HTMLFormElement | null>;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
}

/** Clear every style the pin writes, returning the form to normal flow. */
function releaseForm(form: HTMLFormElement): void {
    form.style.position = '';
    form.style.left = '';
    form.style.right = '';
    form.style.width = '';
    form.style.top = '';
    form.style.height = '';
    form.style.zIndex = '';
    form.style.background = '';
}

export function useMobileViewportPin(options: MobileViewportPinOptions): void {
    const { isMobile, isFullscreen, isDraftScreen, isFocused, formRef, editorRef } = options;

    // Fullscreen: fix the form over the whole visible viewport and track the pan.
    React.useLayoutEffect(() => {
        if (!isMobile || !isFullscreen || isCapacitorApp()) return;
        const vv = window.visualViewport;
        const form = formRef.current;
        const editor = editorRef.current;
        if (!vv || !form) return;

        // The form is trapped inside lower stacking contexts (the composer
        // wrapper's z-10), so it cannot out-stack the app header with z-index
        // alone — hide the header for the duration via a root class instead.
        document.documentElement.classList.add('oc-browser-kb-fullscreen');

        const apply = () => {
            const top = Math.max(0, Math.floor(vv.offsetTop));
            // Stale-visualViewport guard: when the layout viewport is
            // keyboard-resized (interactive-widget), its clientHeight is the
            // authoritative above-keyboard height.
            const layoutHeight = document.documentElement.clientHeight;
            form.style.position = 'fixed';
            form.style.left = '0';
            form.style.right = '0';
            form.style.top = `${top}px`;
            form.style.height = `${Math.floor(Math.min(vv.height, layoutHeight - top))}px`;
            form.style.zIndex = '40';
            form.style.background = 'var(--background)';
        };

        apply();
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
        window.addEventListener('resize', apply);
        window.addEventListener('scroll', apply, true);

        return () => {
            vv.removeEventListener('resize', apply);
            vv.removeEventListener('scroll', apply);
            window.removeEventListener('resize', apply);
            window.removeEventListener('scroll', apply, true);
            document.documentElement.classList.remove('oc-browser-kb-fullscreen');
            releaseForm(form);
            // Back in flow: the browser panned for the fullscreen session and
            // will not re-reveal the still-focused field on its own, which left
            // the composer parked behind the keyboard.
            requestAnimationFrame(() => {
                if (editor?.isFocused()) {
                    editor.getScrollDOM()?.scrollIntoView({ block: 'nearest' });
                }
            });
        };
    }, [editorRef, formRef, isFullscreen, isMobile]);

    // Keyboard up: anchor the normal-height composer to the visible bottom.
    // Draft screen on every mobile browser; chat screen only on Android,
    // where neither viewport resizing nor the focused-field reveal can be
    // relied on (iOS chat keeps the browser's own reveal).
    React.useLayoutEffect(() => {
        if (!isMobile || isCapacitorApp()) return;
        if (isFullscreen || !isFocused) return;
        if (!isDraftScreen && !isAndroidBrowser()) return;
        const vv = window.visualViewport;
        const form = formRef.current;
        if (!vv || !form) return;

        // Keep the in-flow horizontal geometry (page paddings) while fixed.
        const rect = form.getBoundingClientRect();
        form.style.position = 'fixed';
        form.style.left = `${Math.floor(rect.left)}px`;
        form.style.width = `${Math.floor(rect.width)}px`;
        form.style.zIndex = '40';
        form.style.background = 'var(--background)';

        // Safari's visualViewport events are unreliable mid keyboard pan (they
        // can simply not fire), so track the pan with a rAF loop instead —
        // cheap math per frame, a style write only when the value changes.
        let lastTop = Number.NaN;
        let frame = 0;
        const track = () => {
            // iOS standalone (PWA) can serve stale visualViewport metrics after
            // the keyboard rises (full pre-keyboard height, intermittently),
            // parking the form behind the keyboard. When interactive-widget
            // resizes the layout viewport, documentElement.clientHeight is the
            // true above-keyboard bottom — anchor to whichever is smaller. In
            // pan-mode browsers clientHeight stays full height, so the min
            // keeps the visual-viewport anchor there.
            const layoutBottom = document.documentElement.clientHeight;
            const vvBottom = vv.offsetTop + vv.height;
            const top = Math.max(0, Math.floor(Math.min(vvBottom, layoutBottom) - form.offsetHeight));
            if (top !== lastTop) {
                lastTop = top;
                form.style.top = `${top}px`;
            }
            frame = requestAnimationFrame(track);
        };
        track();

        return () => {
            cancelAnimationFrame(frame);
            releaseForm(form);
        };
    }, [formRef, isDraftScreen, isFocused, isFullscreen, isMobile]);

    // iPad Home Screen app: lift the composer by exactly the part the keyboard
    // covers. Past 768px an iPad is a tablet or desktop surface, so isMobile is
    // false and the pins above never run. Only the relatively positioned
    // form's offset moves, leaving the layout around it alone, and the lift is
    // zero whenever nothing is covered (a hardware keyboard, or a field Safari
    // already revealed). Focus is read from the DOM because the composer shell
    // tracks it on the phone surface only.
    React.useLayoutEffect(() => {
        if (isCapacitorApp() || !isIPadHomeScreenApp()) return;
        // The pins above own these screens on the phone surface.
        if (isMobile && (isFullscreen || isDraftScreen)) return;
        const vv = window.visualViewport;
        const form = formRef.current;
        if (!vv || !form) return;

        let lift = 0;
        let frame = 0;
        const setLift = (next: number) => {
            if (next === lift) return;
            lift = next;
            form.style.top = next > 0 ? `${-next}px` : '';
        };
        // A rAF loop for the same reason as above: the keyboard's re-show
        // fires no viewport event at all.
        const track = () => {
            if (!form.contains(document.activeElement)) {
                frame = 0;
                setLift(0);
                return;
            }
            const visibleBottom = Math.min(vv.offsetTop + vv.height, document.documentElement.clientHeight);
            const rect = form.getBoundingClientRect();
            const covered = Math.max(0, Math.ceil(rect.bottom + lift - visibleBottom));
            // A form taller than the room above the keyboard (the expanded
            // composer) stays put: lifting would push its first lines off the
            // top, which is worse than the footer the keyboard hides.
            const fits = rect.top + lift - covered >= vv.offsetTop;
            setLift(fits ? covered : 0);
            frame = requestAnimationFrame(track);
        };
        const start = () => {
            if (frame === 0) track();
        };
        form.addEventListener('focusin', start);
        // Focus can already be inside when a screen change re-runs this.
        start();

        return () => {
            form.removeEventListener('focusin', start);
            cancelAnimationFrame(frame);
            form.style.top = '';
        };
    }, [formRef, isDraftScreen, isFullscreen, isMobile]);
}
