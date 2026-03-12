import React from 'react';

const WIPE_MASK =
    'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 60%, rgba(0,0,0,0) 100%)';

interface ToolRevealOnMountProps {
    children: React.ReactNode;
    animate: boolean;
    wipe?: boolean;
    delayMs?: number;
    className?: string;
}

export const ToolRevealOnMount: React.FC<ToolRevealOnMountProps> = ({
    children,
    animate,
    wipe = true,
    delayMs = 0,
    className,
}) => {
    const rootRef = React.useRef<HTMLDivElement | null>(null);

    const clearRevealStyles = React.useCallback((target: HTMLElement | null) => {
        if (!target) {
            return;
        }
        target.style.opacity = '';
        target.style.filter = '';
        target.style.transform = '';
        target.style.maskImage = '';
        target.style.webkitMaskImage = '';
        target.style.maskSize = '';
        target.style.webkitMaskSize = '';
        target.style.maskRepeat = '';
        target.style.webkitMaskRepeat = '';
        target.style.maskPosition = '';
        target.style.webkitMaskPosition = '';
    }, []);

    React.useLayoutEffect(() => {
        const el = rootRef.current;

        if (!animate) {
            clearRevealStyles(el);
            return;
        }

        if (!el || typeof window === 'undefined') {
            return;
        }

        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            clearRevealStyles(el);
            return;
        }

        const maskSupported =
            wipe &&
            typeof CSS !== 'undefined' &&
            (CSS.supports('mask-image', 'linear-gradient(to right, black, transparent)') ||
                CSS.supports('-webkit-mask-image', 'linear-gradient(to right, black, transparent)'));

        el.style.opacity = '0';
        el.style.filter = wipe ? 'blur(3px)' : 'blur(2px)';
        el.style.transform = wipe ? 'translateX(-0.06em)' : 'translateY(0.04em)';

        if (maskSupported) {
            el.style.maskImage = WIPE_MASK;
            el.style.webkitMaskImage = WIPE_MASK;
            el.style.maskSize = '240% 100%';
            el.style.webkitMaskSize = '240% 100%';
            el.style.maskRepeat = 'no-repeat';
            el.style.webkitMaskRepeat = 'no-repeat';
            el.style.maskPosition = '100% 0%';
            el.style.webkitMaskPosition = '100% 0%';
        }

        let animation: Animation | null = null;
        const frame = window.requestAnimationFrame(() => {
            const node = rootRef.current;
            if (!node) {
                return;
            }

            const keyframes: Keyframe[] = maskSupported
                ? [
                    { opacity: 0, filter: 'blur(3px)', transform: 'translateX(-0.06em)', maskPosition: '100% 0%' },
                    { opacity: 1, filter: 'blur(0px)', transform: 'translateX(0)', maskPosition: '0% 0%' },
                ]
                : [
                    {
                        opacity: 0,
                        filter: wipe ? 'blur(3px)' : 'blur(2px)',
                        transform: wipe ? 'translateX(-0.06em)' : 'translateY(0.04em)',
                    },
                    { opacity: 1, filter: 'blur(0px)', transform: wipe ? 'translateX(0)' : 'translateY(0)' },
                ];

            animation = node.animate(keyframes, {
                duration: 500,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                delay: delayMs,
                fill: 'forwards',
            });

            animation.finished
                .catch(() => undefined)
                .finally(() => {
                    const target = rootRef.current;
                    clearRevealStyles(target);
                });
        });

        return () => {
            window.cancelAnimationFrame(frame);
            animation?.cancel();
            clearRevealStyles(el);
        };
    }, [animate, clearRevealStyles, delayMs, wipe]);

    return (
        <div ref={rootRef} className={className}>
            {children}
        </div>
    );
};
