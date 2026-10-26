import React from 'react';
import { isRightToLeft } from '@/lib/i18n';

const WIPE_MASK =
    'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 60%, rgba(0,0,0,0) 100%)';
// The same wipe mirrored, so a right-to-left row reveals from its start on the right.
const WIPE_MASK_RTL =
    'linear-gradient(to left, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 60%, rgba(0,0,0,0) 100%)';

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
        // target.style.filter = '';
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

        const isRtl = isRightToLeft(el);
        const wipeFrom = isRtl ? 'translateX(0.06em)' : 'translateX(-0.06em)';
        const maskFrom = isRtl ? '0% 0%' : '100% 0%';
        const maskTo = isRtl ? '100% 0%' : '0% 0%';
        const wipeMask = isRtl ? WIPE_MASK_RTL : WIPE_MASK;

        el.style.opacity = '0';
        // el.style.filter = wipe ? 'blur(3px)' : 'blur(2px)';
        el.style.transform = wipe ? wipeFrom : 'translateY(0.04em)';

        if (maskSupported) {
            el.style.maskImage = wipeMask;
            el.style.webkitMaskImage = wipeMask;
            el.style.maskSize = '240% 100%';
            el.style.webkitMaskSize = '240% 100%';
            el.style.maskRepeat = 'no-repeat';
            el.style.webkitMaskRepeat = 'no-repeat';
            el.style.maskPosition = maskFrom;
            el.style.webkitMaskPosition = maskFrom;
        }

        let animation: Animation | null = null;
        const frame = window.requestAnimationFrame(() => {
            const node = rootRef.current;
            if (!node) {
                return;
            }

            const keyframes: Keyframe[] = maskSupported
                ? [
                    { opacity: 0, transform: wipeFrom, maskPosition: maskFrom },
                    { opacity: 1, transform: 'translateX(0)', maskPosition: maskTo },
                ]
                : [
                    {
                        opacity: 0,
                        transform: wipe ? wipeFrom : 'translateY(0.04em)',
                    },
                    { opacity: 1, transform: wipe ? 'translateX(0)' : 'translateY(0)' },
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
