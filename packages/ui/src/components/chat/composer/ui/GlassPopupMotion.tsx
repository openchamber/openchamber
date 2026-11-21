
import React from 'react';
import { usePresence, useReducedMotion } from 'motion/react';

const TIMING = {
    standard: { enter: 140, exit: 100 },
    brief: { enter: 90, exit: 60 },
} as const;
const ENTER_OFFSET = 'translateY(3px)';
const EXIT_OFFSET = 'translateY(2px)';

export function GlassPopupMotion({ children, pace = 'standard', ...rest }: React.HTMLAttributes<HTMLDivElement> & { pace?: keyof typeof TIMING }) {
    const wrapperRef = React.useRef<HTMLDivElement | null>(null);
    const [isPresent, safeToRemove] = usePresence();
    const reduceMotion = useReducedMotion() ?? false;
    const runningRef = React.useRef<Animation[]>([]);

    const play = React.useCallback((entering: boolean): Animation[] => {
        const wrapper = wrapperRef.current;
        if (!wrapper || !('animate' in wrapper)) return [];
        for (const animation of runningRef.current) animation.cancel();
        const timing = entering
            ? { duration: TIMING[pace].enter, easing: 'ease-out' }
            : { duration: TIMING[pace].exit, easing: 'ease-in' };
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
    }, [pace, reduceMotion]);

    React.useLayoutEffect(() => {
        if (!isPresent) return;
        const wrapper = wrapperRef.current;
        if (wrapper) wrapper.style.pointerEvents = '';
        play(true);
    }, [isPresent, play]);

    React.useEffect(() => {
        if (isPresent) return;
        const wrapper = wrapperRef.current;
        if (wrapper) wrapper.style.pointerEvents = 'none';
        const animations = play(false);
        if (animations.length === 0) {
            safeToRemove?.();
            return;
        }
        let cancelled = false;
        void Promise.all(animations.map((animation) => animation.finished)).then(
            () => { if (!cancelled) safeToRemove?.(); },
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
