/**
 * Enter and exit motion for the composer's glass popups: the floating panels
 * (queue, BTW, permission, form), the autocomplete pickers and the
 * context-chip preview.
 *
 * The wrapper moves; its first child, the glass surface, fades. Opacity stays
 * on the glass itself because an ancestor with opacity below 1 is a backdrop
 * root: the blur would go flat for the whole fade and pop back at the end.
 *
 * Exit runs under `AnimatePresence`, which keeps the removed popup mounted
 * until the fade finishes. Outside it, the popup only animates in.
 */

import React from 'react';
import { usePresence, useReducedMotion } from 'motion/react';

const ENTER = { duration: 160, easing: 'ease-out' } as const;
const EXIT = { duration: 120, easing: 'ease-in' } as const;
const ENTER_OFFSET = 'translateY(6px) scale(0.98)';
const EXIT_OFFSET = 'translateY(4px) scale(0.98)';

export function GlassPopupMotion({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
    const wrapperRef = React.useRef<HTMLDivElement | null>(null);
    const [isPresent, safeToRemove] = usePresence();
    const reduceMotion = useReducedMotion() ?? false;
    const runningRef = React.useRef<Animation[]>([]);

    const play = React.useCallback((entering: boolean): Animation[] => {
        const wrapper = wrapperRef.current;
        // Test DOMs may lack the Web Animations API; the popup then just appears.
        if (!wrapper || !('animate' in wrapper)) return [];
        for (const animation of runningRef.current) animation.cancel();
        const timing = entering ? ENTER : EXIT;
        const offset = entering ? ENTER_OFFSET : EXIT_OFFSET;
        const fade = entering ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
        const animations: Animation[] = [];
        if (!reduceMotion) {
            const move = entering ? [{ transform: offset }, { transform: 'none' }] : [{ transform: 'none' }, { transform: offset }];
            animations.push(wrapper.animate(move, { ...timing, fill: entering ? 'none' : 'forwards' }));
        }
        const glass = wrapper.firstElementChild;
        if (glass instanceof HTMLElement) {
            animations.push(glass.animate(fade, { ...timing, fill: entering ? 'none' : 'forwards' }));
        }
        runningRef.current = animations;
        return animations;
    }, [reduceMotion]);

    React.useLayoutEffect(() => {
        if (!isPresent) return;
        const wrapper = wrapperRef.current;
        if (wrapper) wrapper.style.pointerEvents = '';
        play(true);
    }, [isPresent, play]);

    React.useEffect(() => {
        if (isPresent) return;
        const wrapper = wrapperRef.current;
        // A popup on its way out must not take clicks meant for what is below.
        if (wrapper) wrapper.style.pointerEvents = 'none';
        const animations = play(false);
        if (animations.length === 0) {
            safeToRemove?.();
            return;
        }
        let cancelled = false;
        void Promise.all(animations.map((animation) => animation.finished)).then(
            () => { if (!cancelled) safeToRemove?.(); },
            // Cancelled because the popup came back before it finished.
            () => undefined,
        );
        return () => { cancelled = true; };
    }, [isPresent, play, safeToRemove]);

    React.useEffect(() => () => {
        for (const animation of runningRef.current) animation.cancel();
    }, []);

    return (
        <div ref={wrapperRef} {...rest}>
            {children}
        </div>
    );
}
