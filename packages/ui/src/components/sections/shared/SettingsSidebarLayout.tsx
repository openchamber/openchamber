import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';

interface SettingsSidebarLayoutProps {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  variant?: 'sidebar' | 'background';
}

export const SettingsSidebarLayout: React.FC<SettingsSidebarLayoutProps> = ({
  header,
  footer,
  children,
  className,
  variant = 'sidebar',
}) => {
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const scrollRef = React.useRef<HTMLElement | null>(null);
  const [showTopShadow, setShowTopShadow] = React.useState(false);
  const [showBottomShadow, setShowBottomShadow] = React.useState(false);

  const bgClass = variant === 'background'
    ? 'bg-background'
    : (isVSCode ? 'bg-background' : 'bg-sidebar');

  const bgVar = bgClass === 'bg-background'
    ? 'var(--surface-background)'
    : 'var(--surface-muted)';
  
  const updateScrollShadows = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setShowTopShadow(false);
      setShowBottomShadow(false);
      return;
    }
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    if (!canScroll) {
      setShowTopShadow(false);
      setShowBottomShadow(false);
      return;
    }
    setShowTopShadow(el.scrollTop > 1);
    setShowBottomShadow(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  React.useEffect(() => {
    updateScrollShadows();
  }, [children, updateScrollShadows]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateScrollShadows();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [updateScrollShadows]);

  return (
    <div
      className={cn(
        'flex h-full flex-col',
        bgClass,
        className
      )}
    >
      {header}

      <div className="relative flex flex-1 min-h-0 flex-col">
        <ScrollableOverlay
          ref={scrollRef as unknown as React.Ref<HTMLElement>}
          outerClassName="flex-1 min-h-0"
          className="space-y-0.5 px-3 py-2 overflow-x-hidden"
        >
          {children}
        </ScrollableOverlay>

        {showTopShadow && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-4"
            style={{ background: `linear-gradient(to bottom, ${bgVar} 0%, transparent 100%)` }}
          />
        )}
        {showBottomShadow && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
            style={{ background: `linear-gradient(to top, ${bgVar} 0%, transparent 100%)` }}
          />
        )}
      </div>

      {footer}
    </div>
  );
};
