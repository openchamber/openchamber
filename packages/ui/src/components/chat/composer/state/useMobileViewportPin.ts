
import React from 'react';

import { isCapacitorApp, isIPadDevice } from '@/lib/platform';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';

const isAndroidBrowser = (): boolean => /Android/i.test(navigator.userAgent);

// external: #4326 iPad standalone Safari can reopen the keyboard without revealing the field or firing a viewport resize.
const isIPadHomeScreenApp = (): boolean => (
    isIPadDevice() && window.matchMedia?.('(display-mode: standalone)').matches === true
);

export interface MobileViewportPinOptions {
    isMobile: boolean;
    isFullscreen: boolean;
    isDraftScreen: boolean;
    isFocused: boolean;
    formRef: React.RefObject<HTMLFormElement | null>;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
}

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

// external: #5072 Silent keyboard changes require measurement, but per-frame polling keeps a settled page rendering.
const SETTLE_MS = 1000;
const IDLE_CHECK_MS = 250;

interface PinTracker {
    wake: () => void;
    stop: () => void;
}

function createPinTracker(measure: () => boolean): PinTracker {
    let running = false;
    let frame = 0;
    let check: number | undefined;
    let activeUntil = 0;

    const stop = () => {
        running = false;
        cancelAnimationFrame(frame);
        window.clearTimeout(check);
    };
    const tick = (now = performance.now()) => {
        if (measure()) activeUntil = now + SETTLE_MS;
        if (!running) return;
        if (now < activeUntil) frame = requestAnimationFrame(tick);
        else check = window.setTimeout(tick, IDLE_CHECK_MS);
    };
    const wake = () => {
        stop();
        running = true;
        activeUntil = performance.now() + SETTLE_MS;
        tick();
    };
    return { wake, stop };
}

function listenForPinMoves(form: HTMLFormElement, vv: VisualViewport, wake: () => void): () => void {
    const resize = new ResizeObserver(wake);
    resize.observe(form);
    form.addEventListener('focusin', wake);
    form.addEventListener('pointerdown', wake);
    vv.addEventListener('resize', wake);
    vv.addEventListener('scroll', wake);
    window.addEventListener('resize', wake);
    return () => {
        resize.disconnect();
        form.removeEventListener('focusin', wake);
        form.removeEventListener('pointerdown', wake);
        vv.removeEventListener('resize', wake);
        vv.removeEventListener('scroll', wake);
        window.removeEventListener('resize', wake);
    };
}

export function useMobileViewportPin(options: MobileViewportPinOptions): void {
    const { isMobile, isFullscreen, isDraftScreen, isFocused, formRef, editorRef } = options;

    React.useLayoutEffect(() => {
        if (!isMobile || !isFullscreen || isCapacitorApp()) return;
        const vv = window.visualViewport;
        const form = formRef.current;
        const editor = editorRef.current;
        if (!vv || !form) return;

        document.documentElement.classList.add('oc-browser-kb-fullscreen');

        const apply = () => {
            const top = Math.max(0, Math.floor(vv.offsetTop));
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
            requestAnimationFrame(() => {
                if (editor?.isFocused()) {
                    editor.getScrollDOM()?.scrollIntoView({ block: 'nearest' });
                }
            });
        };
    }, [editorRef, formRef, isFullscreen, isMobile]);

    React.useLayoutEffect(() => {
        if (!isMobile || isCapacitorApp()) return;
        if (isFullscreen || !isFocused) return;
        if (!isDraftScreen && !isAndroidBrowser()) return;
        const vv = window.visualViewport;
        const form = formRef.current;
        if (!vv || !form) return;

        const rect = form.getBoundingClientRect();
        form.style.position = 'fixed';
        form.style.left = `${Math.floor(rect.left)}px`;
        form.style.width = `${Math.floor(rect.width)}px`;
        form.style.zIndex = '40';
        form.style.background = 'var(--background)';

        let lastTop = Number.NaN;
        const tracker = createPinTracker(() => {
            const layoutBottom = document.documentElement.clientHeight;
            const vvBottom = vv.offsetTop + vv.height;
            const top = Math.max(0, Math.floor(Math.min(vvBottom, layoutBottom) - form.offsetHeight));
            if (top === lastTop) return false;
            lastTop = top;
            form.style.top = `${top}px`;
            return true;
        });
        const stopListening = listenForPinMoves(form, vv, tracker.wake);
        tracker.wake();

        return () => {
            stopListening();
            tracker.stop();
            releaseForm(form);
        };
    }, [formRef, isDraftScreen, isFocused, isFullscreen, isMobile]);

    React.useLayoutEffect(() => {
        if (isCapacitorApp() || !isIPadHomeScreenApp()) return;
        if (isMobile && (isFullscreen || isDraftScreen)) return;
        const vv = window.visualViewport;
        const form = formRef.current;
        if (!vv || !form) return;

        let lift = 0;
        const setLift = (next: number): boolean => {
            if (next === lift) return false;
            lift = next;
            form.style.top = next > 0 ? `${-next}px` : '';
            return true;
        };
        const tracker = createPinTracker(() => {
            if (!form.contains(document.activeElement)) {
                tracker.stop();
                return setLift(0);
            }
            const visibleBottom = Math.min(vv.offsetTop + vv.height, document.documentElement.clientHeight);
            const rect = form.getBoundingClientRect();
            const covered = Math.max(0, Math.ceil(rect.bottom + lift - visibleBottom));
            const fits = rect.top + lift - covered >= vv.offsetTop;
            return setLift(fits ? covered : 0);
        });
        const stopListening = listenForPinMoves(form, vv, tracker.wake);
        tracker.wake();

        return () => {
            stopListening();
            tracker.stop();
            form.style.top = '';
        };
    }, [formRef, isDraftScreen, isFullscreen, isMobile]);
}
