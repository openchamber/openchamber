import React from 'react';
import { ReceivedPagesList } from '@/components/chat/sharePages/received/ReceivedPagesList';
import { hasReceivedPages, useReceivedPages } from '@/components/chat/sharePages/received/receivedPagesStore';
import { createPortal } from 'react-dom';
import { arrayMove } from '@dnd-kit/sortable';
import { isIMECompositionEvent } from '@/lib/ime';

import { Icon } from '@/components/icon/Icon';
import { ProjectContextPanel } from '@/components/layout/RightSidebarTabs';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { TerminalView } from '@/components/views/TerminalView';
import { useI18n } from '@/lib/i18n';
import { orderMobileWorkspaceTabs, stripMobileWorkspaceTabs, withReceivedPagesTab, type MobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { usePhoneGuestPanelModes } from '@/hooks/useGuestSurfaces';
import { useGuestBadgeStore } from '@/lib/guests/badge-store';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { useGuestsStore } from '@/lib/guests/store';
import { guestHasSharedSurface, guestSurfaceDocking } from '@/lib/guests/surfaces';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { isPluginContextPanelMode, pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import type { ProjectRef } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import { MobileChangesSurface } from './MobileChangesSurface';
import type { MobileChangesCommitRequest } from './mobileChangesCommitRequest';
import type { MobileChangesInitialDiff } from '@/hooks/useMobileChangesNavigation';
import { MobileFilesSurface } from './MobileFilesSurface';
import { MobileStatusPane } from './MobileStatusPane';
import { useEdgeSwipe } from './useEdgeSwipe';
import { isVimEditorEventTarget } from '@/lib/editorFocus';
import { MOBILE_HEADER_BUTTON_CLASS, MOBILE_HEADER_CLASS } from '@/components/ui/mobileHeader';

const MobileBrowserSurface = React.lazy(() => import('./MobileBrowserSurface').then((module) => ({ default: module.MobileBrowserSurface })));
const GuestPanelContent = React.lazy(() => import('@/components/layout/GuestPanelContent').then((module) => ({ default: module.GuestPanelContent })));

const DRAWER_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export const MobileWorkspaceDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  tab: MobileWorkspaceTab;
  onTabChange: (tab: MobileWorkspaceTab) => void;
  registerPreviewBackHandler: (handler: (() => boolean) | null) => void;
  pendingChangesDiff: MobileChangesInitialDiff | null;
  pendingChangesCommit: MobileChangesCommitRequest | null;
  onOpenPlan: (plan: { id: string; title: string; projectRef: ProjectRef }) => void;
  onOpenReceivedPage: (page: { receivedId: string; title: string }) => void;
  variant?: 'drawer' | 'panel';
}> = ({ open, onClose, tab, onTabChange, registerPreviewBackHandler, pendingChangesDiff, pendingChangesCommit, onOpenPlan, onOpenReceivedPage, variant = 'drawer' }) => {
  const { t, direction } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const drawerRef = React.useRef<HTMLElement>(null);
  const [entered, setEntered] = React.useState(false);
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const tabOrder = useUIStore((state) => state.mobileWorkspaceTabOrder);
  const hiddenTabs = useUIStore((state) => state.mobileWorkspaceHiddenTabs);
  const setTabOrder = useUIStore((state) => state.setMobileWorkspaceTabOrder);
  const extensionTabs = usePhoneGuestPanelModes();
  const receivedPagesShown = hasReceivedPages(useReceivedPages());
  const guests = useGuestsStore((state) => state.guests);
  const guestBadges = useGuestBadgeStore((state) => state.countByGuest);
  const [statusSectionsOpen, setStatusSectionsOpen] = React.useState(false);
  const tabRef = React.useRef(tab);
  React.useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  const closeFromEdge = () => onCloseRef.current();
  useEdgeSwipe(drawerRef, {
    enabled: variant === 'drawer' && open,
    ...(direction === 'rtl' ? { onRightEdgeSwipe: closeFromEdge } : { onLeftEdgeSwipe: closeFromEdge }),
  });

  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<MobileWorkspaceTab>>(() => new Set());
  React.useEffect(() => {
    if (!open) return;
    setVisitedTabs((current) => {
      if (current.has(tab)) return current;
      const next = new Set(current);
      next.add(tab);
      return next;
    });
  }, [open, tab]);
  React.useEffect(() => {
    setVisitedTabs((current) => {
      const gone = [...current].filter((id) => isPluginContextPanelMode(id) && !extensionTabs.includes(id));
      if (gone.length === 0) return current;
      return new Set([...current].filter((id) => !gone.includes(id)));
    });
  }, [extensionTabs]);
  const clearGuestBadge = useGuestBadgeStore((state) => state.clearBadge);
  React.useEffect(() => {
    if (open && isPluginContextPanelMode(tab)) clearGuestBadge(pluginIdFromMode(tab));
  }, [clearGuestBadge, open, tab]);

  if (typeof document !== 'undefined' && !rootRef.current) {
    let root = document.getElementById(DRAWER_ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = DRAWER_ROOT_ID;
      document.body.appendChild(root);
    }
    rootRef.current = root;
  }

  React.useEffect(() => {
    if (open) {
      setVisible(true);
      const id = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setEntered(false);
    const id = window.setTimeout(() => setVisible(false), ENTER_DURATION_MS + 40);
    return () => window.clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    if (variant === 'drawer') document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || tabRef.current === 'terminal') return;
      if (isVimEditorEventTarget(event.target)) return;
      if (isIMECompositionEvent(event)) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (variant === 'drawer') document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, variant]);

  if (variant === 'drawer' && !rootRef.current) return null;

  const tabDefinitions = {
    status: { id: 'status', label: t('chat.workStatus.ariaLabel'), icon: <Icon name="list-indefinite" className="h-3.5 w-3.5" /> },
    changes: { id: 'changes', label: t('mobile.menu.git'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
    files: { id: 'files', label: t('mobile.menu.files'), icon: <Icon name="file-text" className="h-3.5 w-3.5" /> },
    terminal: { id: 'terminal', label: t('mobile.menu.terminal'), icon: <Icon name="terminal" className="h-3.5 w-3.5" /> },
    preview: { id: 'preview', label: t('contextPanel.mode.browser'), icon: <Icon name="global" className="h-3.5 w-3.5" /> },
    notes: { id: 'notes', label: t('contextRail.surface.notes'), icon: <Icon name="sticky-note" className="h-3.5 w-3.5" /> },
    pages: { id: 'pages', label: t('contextPanel.mode.pages'), icon: <Icon name="pages" className="h-3.5 w-3.5" /> },
  } satisfies Record<Exclude<MobileWorkspaceTab, PluginContextPanelMode>, SortableTabsStripItem>;
  const extensionTabItem = (mode: PluginContextPanelMode): SortableTabsStripItem => {
    const guestId = pluginIdFromMode(mode);
    const guest = guests.find((entry) => entry.id === guestId);
    const label = guest?.name ?? guestId;
    const count = guestBadges[guestId] ?? 0;
    return {
      id: mode,
      label,
      title: count > 0
        ? t(count === 1 ? 'contextRail.surface.plugin.badgeAriaSingle' : 'contextRail.surface.plugin.badgeAriaPlural', { label, count })
        : label,
      icon: (
        <span className="relative flex">
          <GuestIcon
            icon={resolveGuestIconName(guest?.icon ?? '')}
            iconSrc={guest ? guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset) : undefined}
            className="h-3.5 w-3.5"
          />
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-1.5 -end-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--status-info)] px-0.5 text-[0.5625rem] font-medium leading-none text-[var(--status-info-foreground)]"
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </span>
      ),
    };
  };
  const orderedTabs = stripMobileWorkspaceTabs(tabOrder, hiddenTabs, tab, extensionTabs);
  const stripTabs = receivedPagesShown || tab === 'pages' ? withReceivedPagesTab(orderedTabs) : orderedTabs;
  const tabItems = stripTabs.map((id) => (isPluginContextPanelMode(id) ? extensionTabItem(id) : tabDefinitions[id]));
  const soleTab = tabItems.length === 1 ? tabItems[0] : null;
  const reorderTabs = (activeId: string, overId: string) => {
    const all = orderMobileWorkspaceTabs(tabOrder, extensionTabs);
    const from = all.findIndex((id) => id === activeId);
    const to = all.findIndex((id) => id === overId);
    if (from < 0 || to < 0) return;
    setTabOrder(arrayMove(all, from, to));
  };

  const body = (
    <>
      <div className={MOBILE_HEADER_CLASS}>
        <div className="flex h-9 min-w-0 flex-1 items-center">
          {soleTab ? (
            <h2 className="flex min-w-0 items-center gap-2 px-1 typography-ui-label font-medium text-foreground">
              <span className="flex shrink-0 text-muted-foreground">{soleTab.icon}</span>
              <span className="truncate">{soleTab.label}</span>
            </h2>
          ) : visible ? (
            <SortableTabsStrip
              items={tabItems}
              activeId={tab}
              onSelect={(id) => {
                const next = stripTabs.find((entry) => entry === id);
                if (next) onTabChange(next);
              }}
              onReorder={reorderTabs}
              layoutMode={tabItems.length > 5 ? 'scrollable' : 'fit'}
              variant="active-pill"
              nonCompositedIndicator
              inactiveTabsIconOnly={tabItems.length > 3}
              className="h-full"
            />
          ) : null}
        </div>
        {tab === 'status' ? (
          <button
            type="button"
            className={MOBILE_HEADER_BUTTON_CLASS}
            aria-label={t('chat.workStatus.sections.open')}
            onClick={() => setStatusSectionsOpen(true)}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="list-settings" className="size-5" />
          </button>
        ) : null}
        <button
          type="button"
          className={MOBILE_HEADER_BUTTON_CLASS}
          aria-label={t('mobile.surface.closeAria')}
          onClick={onClose}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="close" className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {visitedTabs.has('status') ? (
          <div className={cn('h-full', tab !== 'status' && 'hidden')}>
            <ErrorBoundary>
              <MobileStatusPane
                visible={open && tab === 'status'}
                onLeave={onClose}
                sectionsDialogOpen={statusSectionsOpen}
                onSectionsDialogOpenChange={setStatusSectionsOpen}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('changes') ? (
          <div
            key={pendingChangesDiff ? `changes:${pendingChangesDiff.path}:${pendingChangesDiff.staged}` : 'changes'}
            className={cn('h-full', tab !== 'changes' && 'hidden')}
          >
            <ErrorBoundary>
              <MobileChangesSurface
                visible={open && tab === 'changes'}
                initialDiff={pendingChangesDiff}
                initialCommit={pendingChangesCommit}
                onNavigatedToChat={onClose}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('files') ? (
          <div className={cn('h-full', tab !== 'files' && 'hidden')}>
            <ErrorBoundary>
              <MobileFilesSurface visible={open && tab === 'files'} />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('terminal') ? (
          <div className={cn('h-full', tab !== 'terminal' && 'hidden')}>
            <ErrorBoundary>
              <TerminalView visible={open && tab === 'terminal'} />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('preview') ? (
          <div className={cn('relative h-full min-h-0 overflow-hidden', tab !== 'preview' && 'hidden')}>
            <ErrorBoundary>
              <React.Suspense fallback={null}>
                <MobileBrowserSurface visible={open && tab === 'preview'} registerBackHandler={registerPreviewBackHandler} />
              </React.Suspense>
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('notes') ? (
          <div className={cn('h-full', tab !== 'notes' && 'hidden')}>
            <ErrorBoundary>
              <ProjectContextPanel visible={open && tab === 'notes'} onActionComplete={onClose} onOpenPlan={onOpenPlan} />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('pages') ? (
          <div className={cn('h-full overflow-y-auto', tab !== 'pages' && 'hidden')}>
            <ErrorBoundary>
              <ReceivedPagesList onOpen={(page, title) => onOpenReceivedPage({ receivedId: page.receivedId, title })} />
            </ErrorBoundary>
          </div>
        ) : null}
        {extensionTabs.map((mode) => {
          if (!visitedTabs.has(mode)) return null;
          const guest = guests.find((entry) => entry.id === pluginIdFromMode(mode));
          if (!guest) return null;
          return (
            <div key={mode} className={cn('h-full', tab !== mode && 'hidden')}>
              <ErrorBoundary>
                <React.Suspense fallback={null}>
                  <GuestPanelContent
                    mode={mode}
                    sharedSurface={guestHasSharedSurface(guest)}
                    docking={guestSurfaceDocking(guest)}
                    surfaceMounted={open && tab === mode}
                  />
                </React.Suspense>
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </>
  );

  if (variant === 'panel') {
    return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">{body}</div>;
  }

  return createPortal(
    <section
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.header.openWorkspaceAria')}
      aria-hidden={!open}
      className="oc-keyboard-inset-surface oc-bottom-safe-surface oc-side-safe-area fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      style={{
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        transform: entered ? 'none' : direction === 'rtl' ? 'translateX(-100%)' : 'translateX(100%)',
        transition: `transform ${ENTER_DURATION_MS}ms ${DRAWER_EASING}`,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {body}
    </section>,
    rootRef.current as HTMLElement,
  );
};
