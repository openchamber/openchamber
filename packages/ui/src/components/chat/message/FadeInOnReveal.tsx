import React from 'react';
import { cn } from '@/lib/utils';

interface FadeInOnRevealProps {
    children: React.ReactNode;
    className?: string;
    skipAnimation?: boolean;
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

export const FadeInOnReveal: React.FC<FadeInOnRevealProps> = ({ children, className, skipAnimation }) => {
    const contextDisabled = React.useContext(FadeInDisabledContext);
    const shouldSkip = skipAnimation || contextDisabled;
    const [visible, setVisible] = React.useState(shouldSkip);

    React.useEffect(() => {
        if (!FADE_ANIMATION_ENABLED || shouldSkip) {
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
    }, [shouldSkip]);

    if (!FADE_ANIMATION_ENABLED || shouldSkip) {
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
