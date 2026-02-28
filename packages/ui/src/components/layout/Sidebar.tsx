import React from 'react';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useUIStore } from '@/stores/useUIStore';
import { useLanguage } from '@/hooks/useLanguage';

export const SIDEBAR_CONTENT_WIDTH = 250;
const SIDEBAR_MIN_WIDTH = 250;
const SIDEBAR_MAX_WIDTH = 500;

interface SidebarProps {
    isOpen: boolean;
    isMobile: boolean;
    children: React.ReactNode;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, isMobile, children }) => {
    const { t } = useLanguage();
    const { sidebarWidth, setSidebarWidth } = useUIStore();
    const [isResizing, setIsResizing] = React.useState(false);
    const startXRef = React.useRef(0);
    const startWidthRef = React.useRef(sidebarWidth || SIDEBAR_CONTENT_WIDTH);

    React.useEffect(() => {
        if (isMobile || !isResizing) {
            return;
        }

        const handlePointerMove = (event: PointerEvent) => {
            const delta = event.clientX - startXRef.current;
            const nextWidth = Math.min(
                SIDEBAR_MAX_WIDTH,
                Math.max(SIDEBAR_MIN_WIDTH, startWidthRef.current + delta)
            );
            setSidebarWidth(nextWidth);
        };

        const handlePointerUp = () => {
            setIsResizing(false);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp, { once: true });

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };
    }, [isMobile, isResizing, setSidebarWidth]);

    React.useEffect(() => {
        if (isMobile && isResizing) {
            setIsResizing(false);
        }
    }, [isMobile, isResizing]);

    if (isMobile) {
        return null;
    }

    const appliedWidth = isOpen ? Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth || SIDEBAR_CONTENT_WIDTH)
    ) : 0;

    const handlePointerDown = (event: React.PointerEvent) => {
        if (!isOpen) {
            return;
        }
        setIsResizing(true);
        startXRef.current = event.clientX;
        startWidthRef.current = appliedWidth;
        event.preventDefault();
    };

    return (
        <aside
            className={cn(
                'relative flex h-full overflow-hidden border-r border-border/40',
                'bg-sidebar/50',
                isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-in-out',
                !isOpen && 'border-r-0'
            )}
            style={{
                width: `${appliedWidth}px`,
                minWidth: `${appliedWidth}px`,
                maxWidth: `${appliedWidth}px`,
                overflowX: 'clip',
            }}
            aria-hidden={!isOpen || appliedWidth === 0}
        >
            {isOpen && (
                <div
                    className={cn(
                        'absolute right-0 top-0 z-20 h-full w-[4px] cursor-col-resize hover:bg-primary/50 transition-colors',
                        isResizing && 'bg-primary'
                    )}
                    onPointerDown={handlePointerDown}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('layout.resizeLeftPanel')}
                />
            )}
            <div
                className={cn(
                    'relative z-10 flex h-full flex-col transition-opacity duration-300 ease-in-out',
                    !isOpen && 'pointer-events-none select-none opacity-0'
                )}
                style={{ width: `${appliedWidth}px`, overflowX: 'hidden' }}
                aria-hidden={!isOpen}
            >
                <div className="flex-1 overflow-hidden">
                    <ErrorBoundary>{children}</ErrorBoundary>
                </div>
            </div>
        </aside>
    );
};
