import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { McpIcon } from '@/components/icons/McpIcon';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { ProjectContextPanel } from '@/components/layout/RightSidebarTabs';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { TerminalView } from '@/components/views/TerminalView';
import { useI18n } from '@/lib/i18n';
import type { ProjectRef } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';

import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';

const DRAWER_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;
// Slightly long, decelerating slide — matches the sessions drawer so both
// sides feel like the same piece of chrome.
const ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export type MobileWorkspaceTab = 'changes' | 'files' | 'terminal' | 'notes' | 'mcp';

/** Quick MCP enable/disable toggles as a workspace pane, with its own slim
    action row (add server → settings, refresh) replacing the old fullscreen
    surface's header actions. */
const McpWorkspacePane: React.FC<{ onOpenMcpSettings: () => void }> = ({ onOpenMcpSettings }) => {
  const { t } = useI18n();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const refreshMcpStatus = useMcpStore((state) => state.refresh);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);

  const refresh = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const minSpinPromise = new Promise((resolve) => window.setTimeout(resolve, 500));
    void Promise.all([
      refreshMcpStatus({ directory: currentDirectory || null, silent: true }),
      loadMcpConfigs({ force: true }),
      minSpinPromise,
    ]).finally(() => setIsRefreshing(false));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 px-2 pt-1">
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={onOpenMcpSettings}
          aria-label={t('settings.mcp.sidebar.actions.addServerTitle')}
          title={t('settings.mcp.sidebar.actions.addServerTitle')}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="add" className="size-5" />
        </button>
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={refresh}
          disabled={isRefreshing}
          aria-label={t('mcpDropdown.actions.refreshAria')}
          title={t('mcpDropdown.actions.refreshAria')}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="refresh" className={cn('size-5', isRefreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <McpDropdownContent
          active
          className="h-full"
          listClassName="max-h-none"
          hideHeader
          mobileListDensity
        />
      </div>
    </div>
  );
};

/** The workspace surfaces as tabs (Changes / Files / Terminal / Notes / MCP).

    Two hosts, same content and same state:
     - `drawer` (default) covers the app and slides in from the right edge —
       the phone, and a tablet in portrait where a side panel would leave no
       usable chat column;
     - `panel` renders inline so the caller can size it as a real sidebar
       beside the chat (tablet, landscape). The caller owns the width and the
       open/close animation there; this component only fills it.

    Closes via the header X, Escape (unless the terminal tab owns the keys), or
    the Android back button (handled by MobileShell). */
export const MobileWorkspaceDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  tab: MobileWorkspaceTab;
  onTabChange: (tab: MobileWorkspaceTab) => void;
  /** When set, the Changes tab opens directly into the per-file diff. */
  pendingChangesDiff: { path: string; staged: boolean } | null;
  /** Notes tab: opens a plan fullscreen (layered above the drawer). */
  onOpenPlan: (plan: { id: string; title: string; projectRef: ProjectRef }) => void;
  /** MCP tab: jump to the MCP settings page pre-seeded with a new server draft. */
  onOpenMcpSettings: () => void;
  variant?: 'drawer' | 'panel';
}> = ({ open, onClose, tab, onTabChange, pendingChangesDiff, onOpenPlan, onOpenMcpSettings, variant = 'drawer' }) => {
  const { t } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  // Kept visible through the exit slide; flipped to hidden once it finishes.
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const tabRef = React.useRef(tab);
  React.useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

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
      if (event.key === 'Escape' && tabRef.current !== 'terminal') onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (variant === 'drawer') document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, variant]);

  if (variant === 'drawer' && !rootRef.current) return null;

  const tabItems: SortableTabsStripItem[] = [
    { id: 'changes', label: t('mobile.menu.changes'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
    { id: 'files', label: t('mobile.menu.files'), icon: <Icon name="file-text" className="h-3.5 w-3.5" /> },
    { id: 'terminal', label: t('mobile.menu.terminal'), icon: <Icon name="terminal" className="h-3.5 w-3.5" /> },
    { id: 'notes', label: t('contextRail.surface.notes'), icon: <Icon name="sticky-note" className="h-3.5 w-3.5" /> },
    { id: 'mcp', label: t('mobile.menu.mcp'), icon: <McpIcon className="h-3.5 w-3.5" /> },
  ];

  const body = (
    <>
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3">
        <div className="flex h-9 min-w-0 flex-1 items-center">
          {/* Mounted only while shown; nonCompositedIndicator keeps the active
              pill off its own compositing layer — creating one inside the
              drawer's slide flickers in WKWebView. */}
          {visible ? (
            <SortableTabsStrip
              items={tabItems}
              activeId={tab}
              onSelect={(id) => onTabChange(id as MobileWorkspaceTab)}
              layoutMode="fit"
              variant="active-pill"
              nonCompositedIndicator
              // Five tabs don't fit with labels — the active tab keeps
              // icon + label, the rest collapse to icons.
              inactiveTabsIconOnly
              className="h-full"
            />
          ) : null}
        </div>
        <button
          type="button"
          className="-mr-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
        {visitedTabs.has('changes') ? (
          <div
            // A newly requested per-file diff remounts the pane so
            // initialDiffPath applies; plain reopens keep the state.
            key={pendingChangesDiff ? `changes:${pendingChangesDiff.path}:${pendingChangesDiff.staged}` : 'changes'}
            className={cn('h-full', tab !== 'changes' && 'hidden')}
          >
            <ErrorBoundary>
              <MobileChangesSurface
                initialDiffPath={pendingChangesDiff?.path ?? null}
                initialDiffStaged={pendingChangesDiff?.staged === true}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('files') ? (
          <div className={cn('h-full', tab !== 'files' && 'hidden')}>
            <ErrorBoundary>
              <MobileFilesSurface />
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
              <ProjectContextPanel onActionComplete={onClose} onOpenPlan={onOpenPlan} />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('mcp') ? (
          <div className={cn('h-full', tab !== 'mcp' && 'hidden')}>
            <ErrorBoundary>
              <McpWorkspacePane onOpenMcpSettings={onOpenMcpSettings} />
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
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.header.openWorkspaceAria')}
      aria-hidden={!open}
      className="oc-keyboard-inset-surface fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      style={{
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        // Settled state drops the transform entirely so the drawer isn't kept
        // on a compositing layer (iOS clips those to the safe-area viewport).
        transform: entered ? 'none' : 'translateX(100%)',
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
