/**
 * Pinning the composer to the visual viewport in mobile browsers.
 *
 * Capacitor has a keyboard choreography that resizes the shell, so the
 * composer stays where it belongs on its own. A mobile browser has nothing of
 * the sort: Safari pans the visual viewport over an unchanged layout instead
 * of shrinking it, so a composer positioned in normal flow ends up partly
 * off-screen or behind the keyboard. Both effects here exist to put it back,
 * and both are deliberately restricted to non-Capacitor mobile.
 *
 * Neither is verifiable from a test: they are corrections for specific WebKit
 * behaviors, and every guard in them marks a case that was observed breaking.
 */

import React from 'react';

import { isCapacitorApp } from '@/lib/platform';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';

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

    // Draft screen with the keyboard up: anchor the normal-height composer to
    // the visible bottom. The chat screen does not need this — its own
    // focused-field reveal works there.
    React.useLayoutEffect(() => {
        if (!isMobile || isCapacitorApp()) return;
        if (!isDraftScreen || isFullscreen || !isFocused) return;
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
}
