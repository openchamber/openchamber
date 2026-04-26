import React from 'react';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Detects mobile keyboard open/close via the Visual Viewport API and manages:
 * - `--oc-keyboard-inset` CSS variable on :root
 * - `--oc-visual-viewport-height` / `--oc-visual-viewport-offset-top` CSS variables
 * - `--oc-keyboard-home-indicator` CSS variable (iOS home bar)
 * - `--oc-keyboard-avoid-offset` on the active input's keyboard-avoid target
 * - `isKeyboardOpen` state in the UI store
 *
 * Platform-specific handling:
 * - iOS: sticky inset with home indicator padding
 * - Android: resize-based detection with `maxObservedLayoutHeight` tracking
 */
export function useMobileKeyboardManager(isMobile: boolean): void {
    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        const root = document.documentElement;

        let stickyKeyboardInset = 0;
        let ignoreOpenUntilZero = false;
        let previousHeight = 0;
        let maxObservedLayoutHeight = 0;
        let previousOrientation = '';
        let keyboardAvoidTarget: HTMLElement | null = null;

        const setKeyboardOpen = useUIStore.getState().setKeyboardOpen;
        const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
        const isAndroid = /Android/i.test(userAgent);
        const isIOS = /iPad|iPhone|iPod/.test(userAgent);

        const clearKeyboardAvoidTarget = () => {
            if (!keyboardAvoidTarget) {
                return;
            }
            keyboardAvoidTarget.style.setProperty('--oc-keyboard-avoid-offset', '0px');
            keyboardAvoidTarget.removeAttribute('data-keyboard-avoid-active');
            keyboardAvoidTarget = null;
        };

        const resolveKeyboardAvoidTarget = (active: HTMLElement | null) => {
            if (!active) {
                return null;
            }
            const explicitTargetId = active.getAttribute('data-keyboard-avoid-target-id');
            if (explicitTargetId) {
                const explicitTarget = document.getElementById(explicitTargetId);
                if (explicitTarget instanceof HTMLElement) {
                    return explicitTarget;
                }
            }
            const markedTarget = active.closest('[data-keyboard-avoid]') as HTMLElement | null;
            if (markedTarget) {
                if (markedTarget.getAttribute('data-keyboard-avoid') === 'none') {
                    return null;
                }
                return markedTarget;
            }
            if (active.classList.contains('overlay-scrollbar-container')) {
                const parent = active.parentElement;
                if (parent instanceof HTMLElement) {
                    return parent;
                }
            }
            return active;
        };

        const forceKeyboardClosed = () => {
            stickyKeyboardInset = 0;
            ignoreOpenUntilZero = true;
            root.style.setProperty('--oc-keyboard-inset', '0px');
            setKeyboardOpen(false);
        };

        const isTextInputTarget = (element: HTMLElement | null) => {
            if (!element) {
                return false;
            }
            const tagName = element.tagName;
            const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
            return isInput || element.isContentEditable;
        };

        let rafId = 0;

        const updateVisualViewport = () => {
            const viewport = window.visualViewport;

            const height = viewport ? Math.round(viewport.height) : window.innerHeight;
            const offsetTop = viewport ? Math.max(0, Math.round(viewport.offsetTop)) : 0;
            const orientation = window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';

            root.style.setProperty('--oc-visual-viewport-offset-top', `${offsetTop}px`);
            root.style.setProperty('--oc-visual-viewport-height', `${height}px`);

            const active = document.activeElement as HTMLElement | null;
            const isTextTarget = isTextInputTarget(active);

            const layoutHeight = Math.round(root.clientHeight || window.innerHeight);
            if (previousOrientation !== orientation) {
                previousOrientation = orientation;
                maxObservedLayoutHeight = layoutHeight;
            } else if (layoutHeight > maxObservedLayoutHeight || maxObservedLayoutHeight === 0) {
                maxObservedLayoutHeight = layoutHeight;
            }
            const viewportSum = height + offsetTop;
            const rawInset = Math.max(0, layoutHeight - viewportSum);
            const rawAndroidResizeInset = isAndroid
                ? Math.max(0, maxObservedLayoutHeight - layoutHeight)
                : 0;

            const openThreshold = isTextTarget ? 120 : 180;
            const measuredInset = rawInset >= openThreshold ? rawInset : 0;
            const androidResizeInset = isTextTarget && rawAndroidResizeInset >= openThreshold
                ? rawAndroidResizeInset
                : 0;
            const effectiveMeasuredInset = Math.max(measuredInset, androidResizeInset);

            if (ignoreOpenUntilZero) {
                if (effectiveMeasuredInset === 0) {
                    ignoreOpenUntilZero = false;
                }
                stickyKeyboardInset = 0;
            } else if (stickyKeyboardInset === 0) {
                if (effectiveMeasuredInset > 0 && isTextTarget) {
                    stickyKeyboardInset = effectiveMeasuredInset;
                    setKeyboardOpen(true);
                }
            } else {
                const closingByHeight = !isTextTarget && height > previousHeight + 6;

                if (effectiveMeasuredInset === 0) {
                    stickyKeyboardInset = 0;
                    setKeyboardOpen(false);
                } else if (closingByHeight) {
                    forceKeyboardClosed();
                } else if (effectiveMeasuredInset > 0 && isTextTarget) {
                    stickyKeyboardInset = effectiveMeasuredInset;
                    setKeyboardOpen(true);
                } else if (effectiveMeasuredInset > stickyKeyboardInset) {
                    stickyKeyboardInset = effectiveMeasuredInset;
                    setKeyboardOpen(true);
                }
            }

            root.style.setProperty('--oc-keyboard-inset', `${stickyKeyboardInset}px`);
            previousHeight = height;

            const keyboardHomeIndicator = isIOS && stickyKeyboardInset > 0 ? 34 : 0;
            root.style.setProperty('--oc-keyboard-home-indicator', `${keyboardHomeIndicator}px`);

            const avoidTarget = isTextTarget ? resolveKeyboardAvoidTarget(active) : null;

            if (!isMobile || !avoidTarget || !active) {
                clearKeyboardAvoidTarget();
            } else {
                if (avoidTarget !== keyboardAvoidTarget) {
                    clearKeyboardAvoidTarget();
                    keyboardAvoidTarget = avoidTarget;
                }
                const viewportBottom = offsetTop + height;
                const rect = active.getBoundingClientRect();
                const overlap = rect.bottom - viewportBottom;
                const clearance = 8;
                const keyboardInset = Math.max(stickyKeyboardInset, effectiveMeasuredInset);
                const avoidOffset = overlap > clearance && keyboardInset > 0
                    ? Math.min(overlap, keyboardInset)
                    : 0;
                const target = keyboardAvoidTarget;
                if (target) {
                    target.style.setProperty('--oc-keyboard-avoid-offset', `${avoidOffset}px`);
                    target.setAttribute('data-keyboard-avoid-active', 'true');
                }
            }

            if (isMobile && isTextTarget) {
                const scroller = document.scrollingElement;
                if (scroller && scroller.scrollTop !== 0) {
                    scroller.scrollTop = 0;
                }
                if (window.scrollY !== 0) {
                    window.scrollTo(0, 0);
                }
            }
        };

        const scheduleVisualViewportUpdate = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                updateVisualViewport();
            });
        };

        updateVisualViewport();

        const viewport = window.visualViewport;
        viewport?.addEventListener('resize', scheduleVisualViewportUpdate);
        viewport?.addEventListener('scroll', scheduleVisualViewportUpdate);
        window.addEventListener('resize', scheduleVisualViewportUpdate);
        window.addEventListener('orientationchange', scheduleVisualViewportUpdate);

        const handleFocusIn = (event: FocusEvent) => {
            const target = event.target as HTMLElement | null;
            if (isTextInputTarget(target)) {
                ignoreOpenUntilZero = false;
            }
            scheduleVisualViewportUpdate();
        };
        document.addEventListener('focusin', handleFocusIn, true);

        const handleFocusOut = (event: FocusEvent) => {
            const target = event.target as HTMLElement | null;
            if (!isTextInputTarget(target)) {
                return;
            }

            const related = event.relatedTarget as HTMLElement | null;
            if (isTextInputTarget(related)) {
                return;
            }

            window.requestAnimationFrame(() => {
                if (isTextInputTarget(document.activeElement as HTMLElement | null)) {
                    return;
                }

                const currentViewport = window.visualViewport;
                const height = currentViewport ? Math.round(currentViewport.height) : window.innerHeight;
                const offsetTop = currentViewport ? Math.max(0, Math.round(currentViewport.offsetTop)) : 0;
                const layoutHeight = Math.round(root.clientHeight || window.innerHeight);
                const viewportSum = height + offsetTop;
                const rawInset = Math.max(0, layoutHeight - viewportSum);

                if (rawInset > 0) {
                    updateVisualViewport();
                    return;
                }

                forceKeyboardClosed();
                updateVisualViewport();
            });
        };

        document.addEventListener('focusout', handleFocusOut, true);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            viewport?.removeEventListener('resize', scheduleVisualViewportUpdate);
            viewport?.removeEventListener('scroll', scheduleVisualViewportUpdate);
            window.removeEventListener('resize', scheduleVisualViewportUpdate);
            window.removeEventListener('orientationchange', scheduleVisualViewportUpdate);
            document.removeEventListener('focusin', handleFocusIn, true);
            document.removeEventListener('focusout', handleFocusOut, true);
            clearKeyboardAvoidTarget();
        };
    }, [isMobile]);
}
