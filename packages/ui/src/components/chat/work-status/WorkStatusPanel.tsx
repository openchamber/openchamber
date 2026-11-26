import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DockedPanelSurfaceContext } from '@/hooks/usePageColors';
import { ScrollShadow, ScrollShadowBands } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/useUIStore';
import { WORK_STATUS_PANEL_WIDTH } from './useWorkStatusVisibility';
import { setWorkStatusColumn } from '@/components/layout/rightSlot';
import { LAYOUT_ANIMATION_EASING } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { WorkStatusSectionsDialog } from './WorkStatusSectionsDialog';
import { WorkStatusSectionList } from './WorkStatusSectionList';
import { getWorkStatusPanelPresentation, isWorkStatusSectionVisible } from './sections';
import { useLoadSessionTodos } from './useLoadSessionTodos';
import { useWorkStatusSectionLayout } from './useWorkStatusSectionLayout';
import { WorkStatusPresenceProvider } from './presence';
import { Icon } from '@/components/icon/Icon';

type Props = {
  sessionId: string | null;
  directory: string | null;
  repositoryEnabled?: boolean;
  visible: boolean;
  reserved?: boolean;
  besidePanel?: boolean;
  overlay?: boolean;
};

const PANEL_TRANSITION_EASING = LAYOUT_ANIMATION_EASING;

export const WorkStatusPanel: React.FC<Props> = ({ sessionId, directory, visible, reserved = false, besidePanel = false, repositoryEnabled = true, overlay = false }) => {
  const { t, direction } = useI18n();
  const panelTransitionMs = useLayoutAnimationMs();
  const setScrollTop = useUIStore((state) => state.setWorkStatusScrollTop);
  const setOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);
  const sectionLayout = useWorkStatusSectionLayout();
  const { allSectionsHidden } = sectionLayout;
  useLoadSessionTodos(sessionId, directory, visible && isWorkStatusSectionVisible(sectionLayout.hiddenSections, 'tasks'));
  const [sectionsDialogOpen, setSectionsDialogOpen] = React.useState(false);
  const [renderedSections, setRenderedSections] = React.useState(1);
  const frameRef = React.useRef<number | null>(null);

  const [contentMounted, setContentMounted] = React.useState(visible);
  const { interactive, showEmptyState } = getWorkStatusPanelPresentation({
    visible,
    contentMounted,
    renderedSections,
    allSectionsHidden,
  });
  React.useEffect(() => {
    if (visible) {
      setContentMounted(true);
      setRenderedSections((count) => Math.max(count, 1));
      return undefined;
    }
    const timer = window.setTimeout(() => setContentMounted(false), panelTransitionMs);
    return () => window.clearTimeout(timer);
  }, [panelTransitionMs, visible]);

  const empty = contentMounted && renderedSections === 0 && !allSectionsHidden;
  const wantsColumn = !overlay && reserved && !empty;
  const wantsColumnBesidePanel = wantsColumn && besidePanel;
  React.useLayoutEffect(() => {
    if (overlay) return undefined;
    setWorkStatusColumn(wantsColumn, wantsColumnBesidePanel);
    return () => setWorkStatusColumn(false, false);
  }, [overlay, wantsColumn, wantsColumnBesidePanel]);

  const restore = React.useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const stored = useUIStore.getState().workStatusScrollTop;
    if (stored > 0) node.scrollTop = stored;
  }, []);

  const handleScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
    const { scrollTop } = event.currentTarget;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(scrollTop);
    });
  }, [setScrollTop]);

  React.useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  React.useEffect(() => {
    setScrollTop(0);
  }, [sessionId, setScrollTop]);

  const overlayRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!overlay || !visible || sectionsDialogOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (overlayRef.current?.contains(target)) return;
      if (target?.closest('[data-work-status-toggle]')) return;
      if (target?.closest('[data-work-status-popup]')) return;
      setOverlayOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlayOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overlay, setOverlayOpen, visible, sectionsDialogOpen]);

  return (
    <aside
      ref={overlayRef}
      aria-label={t('chat.workStatus.ariaLabel')}
      aria-hidden={!interactive}
      inert={!interactive}
      className={cn(
        'relative my-4 ms-2 me-4 flex shrink-0 flex-col self-start overflow-hidden',
        'max-h-[calc(100%-2rem)]',
        overlay && [
          'absolute inset-e-3 top-3 z-30 mx-0 my-0',
          'max-h-[calc(100%-1.5rem)]',
        ],
        'motion-reduce:transition-none',
        'oc-panel-edge rounded-xl',
        !overlay && 'bg-background',
      )}
      data-edge-hidden={overlay && !interactive ? '' : undefined}
      data-edge-floating={overlay ? '' : undefined}
      style={{
        // external: https://drafts.csswg.org/filter-effects-2/#BackdropRoot Ancestor opacity below 1 blocks the glass from sampling the transcript.
        width: WORK_STATUS_PANEL_WIDTH,
        maxWidth: overlay ? 'calc(100% - 1.5rem)' : undefined,
        opacity: overlay || interactive ? 1 : 0,
        transform: overlay ? (visible ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.98)') : undefined,
        transformOrigin: direction === 'rtl' ? 'top left' : 'top right',
        transitionProperty: overlay ? 'transform, box-shadow' : 'opacity',
        transitionDuration: `${panelTransitionMs}ms`,
        transitionTimingFunction: PANEL_TRANSITION_EASING,
        pointerEvents: interactive ? undefined : 'none',
      }}
    >
      <DockedPanelSurfaceContext.Provider value={!overlay}>
      <div
        className={cn('relative flex min-h-0 flex-1 flex-col', overlay && 'oc-glass-panel')}
        style={overlay ? {
          opacity: interactive ? 1 : 0,
          transitionProperty: 'opacity',
          transitionDuration: `${panelTransitionMs}ms`,
          transitionTimingFunction: PANEL_TRANSITION_EASING,
        } : undefined}
      >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('chat.workStatus.sections.open')}
            onClick={() => setSectionsDialogOpen(true)}
            className="absolute inset-e-2 top-2 z-10 inline-flex h-6 items-center rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="list-settings" className="size-[13px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{t('chat.workStatus.sections.open')}</TooltipContent>
      </Tooltip>

      {contentMounted ? (
      <WorkStatusPresenceProvider onChange={setRenderedSections}>
      <ScrollShadow
        ref={restore}
        onScroll={handleScroll}
        size={24}
        surface={overlay ? undefined : 'var(--background)'}
        className="oc-hide-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2 [&>section:first-child>[data-work-status-heading]]:pe-7"
      >
        <WorkStatusSectionList
          sessionId={sessionId}
          directory={directory}
          repositoryEnabled={repositoryEnabled}
          layout={sectionLayout}
          visible={visible}
        />
      </ScrollShadow>
      {overlay ? null : <ScrollShadowBands surface="var(--background)" size={24} />}
      </WorkStatusPresenceProvider>
      ) : null}

      {showEmptyState ? (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
          <span className="text-sm text-muted-foreground">{t('chat.workStatus.sections.allHidden')}</span>
          <Button
            variant="link"
            size="xs"
            onClick={() => setSectionsDialogOpen(true)}
            className="mt-2 normal-case text-muted-foreground hover:text-foreground"
          >
            {t('chat.workStatus.sections.open')}
          </Button>
        </div>
      ) : null}
      </div>
      </DockedPanelSurfaceContext.Provider>

      <WorkStatusSectionsDialog open={sectionsDialogOpen} onOpenChange={setSectionsDialogOpen} />
    </aside>
  );
};
