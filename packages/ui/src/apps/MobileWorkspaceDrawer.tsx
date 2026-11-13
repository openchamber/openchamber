import React from 'react';
import { createPortal } from 'react-dom';
import { arrayMove } from '@dnd-kit/sortable';
import { isIMECompositionEvent } from '@/lib/ime';

import { Icon } from '@/components/icon/Icon';
import { ProjectContextPanel } from '@/components/layout/RightSidebarTabs';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { TerminalView } from '@/components/views/TerminalView';
import { useI18n } from '@/lib/i18n';
import { orderMobileWorkspaceTabs, stripMobileWorkspaceTabs, type MobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import type { ProjectRef } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';
import { MobileStatusPane } from './MobileStatusPane';
import { useEdgeSwipe } from './useEdgeSwipe';
import { isVimEditorEventTarget } from '@/lib/editorFocus';

const DRAWER_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;
// Slightly long, decelerating slide — matches the sessions drawer so both
// sides feel like the same piece of chrome.
const ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** The workspace surfaces as tabs (Status / Changes / Files / Terminal / Notes).

    Two hosts, same content and same state:
     - `drawer` (default) covers the app and slides in from the right edge —
       the phone, and a tablet in portrait where a side panel would leave no
       usable chat column;
     - `panel` renders inline so the caller can size it as a real sidebar
       beside the chat (tablet, landscape). The caller owns the width and the
       open/close animation there; this component only fills it.

    Closes via the header X, a left-edge swipe back toward the right (the
    mirror of the gesture that opened it), Escape (unless the terminal tab owns
    the keys), or the Android back button (handled by MobileShell). */
export const MobileWorkspaceDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  tab: MobileWorkspaceTab;
  onTabChange: (tab: MobileWorkspaceTab) => void;
  /** When set, the Changes tab opens directly into the per-file diff. */
  pendingChangesDiff: { path: string; staged: boolean } | null;
  /** Notes tab: opens a plan fullscreen (layered above the drawer). */
  onOpenPlan: (plan: { id: string; title: string; projectRef: ProjectRef }) => void;
  variant?: 'drawer' | 'panel';
}> = ({ open, onClose, tab, onTabChange, pendingChangesDiff, onOpenPlan, variant = 'drawer' }) => {
  const { t, direction } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const drawerRef = React.useRef<HTMLElement>(null);
  const [entered, setEntered] = React.useState(false);
  // Kept visible through the exit slide; flipped to hidden once it finishes.
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const tabOrder = useUIStore((state) => state.mobileWorkspaceTabOrder);
  const hiddenTabs = useUIStore((state) => state.mobileWorkspaceHiddenTabs);
  const setTabOrder = useUIStore((state) => state.setMobileWorkspaceTabOrder);
  // The Status tab's section picker opens from the tab row, beside the close button.
  const [statusSectionsOpen, setStatusSectionsOpen] = React.useState(false);
  const tabRef = React.useRef(tab);
  React.useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Swipe from the drawer's start edge back toward its end = close, the
  // reverse of the end-edge swipe that opened it from the chat. Only the
  // full-cover drawer has an edge to grab; the tablet panel is closed from the
  // header instead.
  const closeFromEdge = () => onCloseRef.current();
  useEdgeSwipe(drawerRef, {
    enabled: variant === 'drawer' && open,
    ...(direction === 'rtl' ? { onRightEdgeSwipe: closeFromEdge } : { onLeftEdgeSwipe: closeFromEdge }),
  });

  // Tabs the user has actually opened — their panes stay mounted afterwards.
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
    // Only the full-cover drawer owns the page scroll; the inline panel sits
    // inside the shell and must leave the chat beside it scrollable.
    const previousOverflow = document.body.style.overflow;
    if (variant === 'drawer') document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      // The terminal owns Escape (it goes to the PTY) — don't hijack it.
      // The same goes for the file editor on the Vim keymap, where Escape
      // leaves INSERT mode (hardware keyboards on tablets and phones), and
      // for an IME composition, where it dismisses the candidate window.
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
    notes: { id: 'notes', label: t('contextRail.surface.notes'), icon: <Icon name="sticky-note" className="h-3.5 w-3.5" /> },
  } satisfies Record<MobileWorkspaceTab, SortableTabsStripItem>;
  // The user's tabs in their order (Settings > General), plus a hidden one
  // while something opened it.
  const stripTabs = stripMobileWorkspaceTabs(tabOrder, hiddenTabs, tab);
  const tabItems = stripTabs.map((id) => tabDefinitions[id]);
  const soleTab = tabItems.length === 1 ? tabItems[0] : null;
  // A long press on a tab drags it; the new order covers hidden tabs too.
  const reorderTabs = (activeId: string, overId: string) => {
    const all = orderMobileWorkspaceTabs(tabOrder);
    const from = all.findIndex((id) => id === activeId);
    const to = all.findIndex((id) => id === overId);
    if (from < 0 || to < 0) return;
    setTabOrder(arrayMove(all, from, to));
  };

  const body = (
    <>
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3">
        <div className="flex h-9 min-w-0 flex-1 items-center">
          {/* Mounted only while shown; nonCompositedIndicator keeps the active
              pill off its own compositing layer — creating one inside the
              drawer's slide flickers in WKWebView. */}
          {/* One tab has nothing to switch to: it is named, not offered. */}
          {soleTab ? (
            <h2 className="flex min-w-0 items-center gap-2 px-1 typography-ui-header font-semibold text-foreground">
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
              layoutMode="fit"
              variant="active-pill"
              nonCompositedIndicator
              // More than three tabs don't fit with labels: the active tab
              // keeps icon + label, the rest collapse to icons.
              inactiveTabsIconOnly={tabItems.length > 3}
              className="h-full"
            />
          ) : null}
        </div>
        {tab === 'status' ? (
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('chat.workStatus.sections.open')}
            onClick={() => setStatusSectionsOpen(true)}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="equalizer-2" className="size-5" />
          </button>
        ) : null}
        <button
          type="button"
          className="-me-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('mobile.surface.closeAria')}
          onClick={onClose}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="close" className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {/* Panes stay MOUNTED once visited (hidden when inactive/closed), so
            reopening the drawer lands exactly where the user left off — an
            open diff, an edited file, an attached terminal. */}
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
            // A newly requested per-file diff remounts the pane so
            // initialDiff applies; plain reopens keep the state.
            key={pendingChangesDiff ? `changes:${pendingChangesDiff.path}:${pendingChangesDiff.staged}` : 'changes'}
            className={cn('h-full', tab !== 'changes' && 'hidden')}
          >
            <ErrorBoundary>
              <MobileChangesSurface
                visible={open && tab === 'changes'}
                initialDiff={pendingChangesDiff}
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
        {visitedTabs.has('notes') ? (
          <div className={cn('h-full', tab !== 'notes' && 'hidden')}>
            <ErrorBoundary>
              <ProjectContextPanel visible={open && tab === 'notes'} onActionComplete={onClose} onOpenPlan={onOpenPlan} />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>
    </>
  );

  if (variant === 'panel') {
    // The caller animates the width; the content itself is plain flow so it
    // never gets its own compositing layer (iOS clips those to the safe-area
    // viewport, which is exactly what the drawer's settled `transform: none`
    // avoids on the other host).
    return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">{body}</div>;
  }

  return createPortal(
    <section
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.header.openWorkspaceAria')}
      aria-hidden={!open}
      className="oc-keyboard-inset-surface oc-bottom-safe-surface fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      style={{
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        // Settled state drops the transform entirely so the drawer isn't kept
        // on a compositing layer (iOS clips those to the safe-area viewport).
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
