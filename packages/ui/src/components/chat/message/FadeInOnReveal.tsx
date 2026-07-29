import React from 'react';
import { cn } from '@/lib/utils';

interface FadeInOnRevealProps {
    children: React.ReactNode;
    className?: string;
    skipAnimation?: boolean;
    forceAnimation?: boolean;
    ignoreContextDisabled?: boolean;
    respectReducedMotion?: boolean;
}

const FADE_ANIMATION_ENABLED = false;

// Context to allow parent components (like VirtualMessageList) to disable animations
// for items entering the viewport due to scrolling rather than new content
const FadeInDisabledContext = React.createContext(false);

export const FadeInDisabledProvider: React.FC<{ disabled: boolean; children: React.ReactNode }> = ({ disabled, children }) => (
    <FadeInDisabledContext.Provider value={disabled}>
        {children}
    </FadeInDisabledContext.Provider>
);

export const FadeInOnReveal: React.FC<FadeInOnRevealProps> = ({
    children,
    className,
    skipAnimation,
    forceAnimation = false,
    ignoreContextDisabled = false,
    respectReducedMotion = false,
}) => {
    const contextDisabled = React.useContext(FadeInDisabledContext);
    const reducedMotion =
        respectReducedMotion &&
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldSkip = Boolean(skipAnimation) || (!ignoreContextDisabled && contextDisabled) || reducedMotion;
    const animationEnabled = FADE_ANIMATION_ENABLED || forceAnimation;
    // Latch the animate/skip decision at mount. If skipAnimation flips to true
    // mid-transition (e.g. the "animate on mount" flag is consumed on the next
    // re-render), unwrapping the animated div would cut the translate short and
    // visibly snap the content up by the remaining offset.
    const animateRef = React.useRef<boolean | null>(null);
    if (animateRef.current === null) {
        animateRef.current = animationEnabled && !shouldSkip;
    }
    const animate = animateRef.current;
    const [visible, setVisible] = React.useState(!animate);

    React.useEffect(() => {
        if (!animate) {
            return;
        }

        let frame: number | null = null;

        const enable = () => setVisible(true);

        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            frame = window.requestAnimationFrame(enable);
        } else {
            enable();
        }

        return () => {
            if (
                frame !== null &&
                typeof window !== 'undefined' &&
                typeof window.cancelAnimationFrame === 'function'
            ) {
                window.cancelAnimationFrame(frame);
            }
        };
    }, [animate]);

    if (!animate) {
        return <>{children}</>;
    }

    return (
        <div
            className={cn(
                'w-full transition-all duration-300 ease-out',
                visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
                className
            )}
        >
            {children}
        </div>
    );
};
