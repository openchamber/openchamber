import React from 'react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface ToolScrollableSectionProps {
    children: React.ReactNode;
    maxHeightClass?: string;
    className?: string;
    outerClassName?: string;
    disableHorizontal?: boolean;
    followKey?: string;
}

export const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
    children,
    maxHeightClass = 'max-h-[60vh]',
    className,
    outerClassName,
    disableHorizontal = false,
    followKey,
}) => {
    const scrollRef = React.useRef<HTMLElement>(null);
    const isFollowingRef = React.useRef(true);
    const lastScrollTopRef = React.useRef(0);

    React.useLayoutEffect(() => {
        const element = scrollRef.current;
        if (followKey === undefined) {
            isFollowingRef.current = true;
            return;
        }
        if (!element || !isFollowingRef.current) {
            return;
        }
        element.scrollTop = element.scrollHeight;
        // Read back the clamped position before the queued scroll event fires.
        lastScrollTopRef.current = element.scrollTop;
    }, [followKey]);

    return (
        <ScrollableOverlay
            ref={scrollRef}
            outerClassName={cn('w-full min-w-0 flex-none', maxHeightClass, outerClassName)}
            useScrollShadow
            // Tool output boxes are short (often 240px), so the 48px default
            // fade would hide a couple of lines at each edge.
            scrollShadowSize={24}
            disableHorizontal={disableHorizontal}
            data-scrollable="true"
            onWheelCapture={(event) => {
                if (followKey !== undefined && event.deltaY < 0) {
                    isFollowingRef.current = false;
                }
            }}
            onScroll={(event) => {
                if (followKey === undefined) {
                    return;
                }
                const element = event.currentTarget;
                const distanceToEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
                // Output can grow between an automatic scroll and its event.
                // A larger bottom gap alone does not mean the reader moved up.
                if (distanceToEnd <= 2) {
                    isFollowingRef.current = true;
                } else if (element.scrollTop < lastScrollTopRef.current - 1) {
                    isFollowingRef.current = false;
                }
                lastScrollTopRef.current = element.scrollTop;
            }}
            className={cn('tool-output-surface min-w-0', className)}
        >
            <div className="w-full min-w-0">
                {children}
            </div>
        </ScrollableOverlay>
    );
};
