import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useAgentBrowserStore } from '@/stores/useAgentBrowserStore';
import type { BrowserViewportPreset } from '@/lib/browser/agentBrowserApi';
import { fetchBrowserArtifactObjectUrl } from '@/lib/browser/agentBrowserApi';

type AgentBrowserViewProps = {
  visible?: boolean;
};

const VIEWPORT_PRESETS: { preset: Exclude<BrowserViewportPreset, 'custom'>; icon: IconName; labelKey: Parameters<ReturnType<typeof useI18n>['t']>[0] }[] = [
  { preset: 'desktop', icon: 'computer', labelKey: 'agentBrowser.viewport.desktop' },
  { preset: 'laptop', icon: 'window', labelKey: 'agentBrowser.viewport.laptop' },
  { preset: 'tablet', icon: 'window', labelKey: 'agentBrowser.viewport.tablet' },
  { preset: 'mobile', icon: 'smartphone', labelKey: 'agentBrowser.viewport.mobile' },
];

const specialKeyFor = (event: React.KeyboardEvent): string | null => {
  const map: Record<string, string> = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  };
  const base = map[event.key];
  if (!base) return null;
  const modifiers = [event.ctrlKey && 'Control', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
  return [...modifiers, base].join('+');
};

const ArtifactThumb: React.FC<{ id: string; kind: string; onOpen: (url: string) => void }> = ({ id, kind, onOpen }) => {
  const { t } = useI18n();
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (kind !== 'screenshot') return;
    let revoked = false;
    let objectUrl: string | null = null;
    void fetchBrowserArtifactObjectUrl(id).then((next) => {
      if (revoked) {
        URL.revokeObjectURL(next);
        return;
      }
      objectUrl = next;
      setUrl(next);
    }).catch(() => {});
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, kind]);

  return (
    <button
      type="button"
      onClick={() => url && onOpen(url)}
      className="group relative h-14 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-[var(--surface-raised)] transition-colors hover:border-[var(--interactive-border-hover)]"
      title={kind === 'recording' ? t('agentBrowser.artifacts.recording') : t('agentBrowser.artifacts.screenshot')}
    >
      {kind === 'screenshot' && url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Icon name={kind === 'recording' ? 'play' : 'file-image'} className="size-5" />
        </span>
      )}
    </button>
  );
};

export const AgentBrowserView: React.FC<AgentBrowserViewProps> = ({ visible = true }) => {
  const { t } = useI18n();
  const supported = useAgentBrowserStore((s) => s.supported);
  const hydrated = useAgentBrowserStore((s) => s.hydrated);
  const tabs = useAgentBrowserStore((s) => s.tabs);
  const activeTabId = useAgentBrowserStore((s) => s.activeTabId);
  const recording = useAgentBrowserStore((s) => s.recording);
  const artifacts = useAgentBrowserStore((s) => s.artifacts);
  const error = useAgentBrowserStore((s) => s.error);
  const connection = useAgentBrowserStore((s) => s.connection);
  const mount = useAgentBrowserStore((s) => s.mount);
  const unmount = useAgentBrowserStore((s) => s.unmount);
  const watch = useAgentBrowserStore((s) => s.watch);
  const run = useAgentBrowserStore((s) => s.run);

  const activeTab = React.useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);
  const frame = useAgentBrowserStore((s) => (activeTabId ? s.frameByTab[activeTabId] : undefined));
  const cursor = useAgentBrowserStore((s) => (activeTabId ? s.cursorByTab[activeTabId] : undefined));

  const [urlInput, setUrlInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<string | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);

  React.useEffect(() => {
    mount();
    return () => unmount();
  }, [mount, unmount]);

  React.useEffect(() => {
    watch(visible ? activeTabId : null);
  }, [watch, visible, activeTabId]);

  React.useEffect(() => {
    setUrlInput(activeTab?.url && activeTab.url !== 'about:blank' ? activeTab.url : '');
  }, [activeTab?.id, activeTab?.url]);

  const guard = React.useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // errors surface through the store's error slice
    } finally {
      setBusy(false);
    }
  }, []);

  const handleNavigate = React.useCallback(() => {
    const url = urlInput.trim();
    if (!url) return;
    void guard(() => run('navigate', { tabId: activeTabId ?? undefined, url }));
  }, [urlInput, guard, run, activeTabId]);

  const handleReload = React.useCallback(() => {
    if (!activeTab?.url) return;
    void guard(() => run('navigate', { tabId: activeTab.id, url: activeTab.url }));
  }, [activeTab, guard, run]);

  const handleNewTab = React.useCallback(() => {
    void guard(() => run('tab.create', {}));
  }, [guard, run]);

  const handleSelectTab = React.useCallback((tabId: string) => {
    void run('tab.select', { tabId });
  }, [run]);

  const handleCloseTab = React.useCallback((tabId: string) => {
    void run('tab.close', { tabId });
  }, [run]);

  const mapPoint = React.useCallback((event: React.PointerEvent | React.WheelEvent): { x: number; y: number } | null => {
    const image = imageRef.current;
    if (!image || !activeTab) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(activeTab.viewport.width, fx * activeTab.viewport.width)),
      y: Math.max(0, Math.min(activeTab.viewport.height, fy * activeTab.viewport.height)),
    };
  }, [activeTab]);

  const handleSurfaceClick = React.useCallback((event: React.PointerEvent) => {
    const point = mapPoint(event);
    if (!point || !activeTabId) return;
    void run('click', { tabId: activeTabId, ...point });
  }, [mapPoint, run, activeTabId]);

  const handleSurfaceWheel = React.useCallback((event: React.WheelEvent) => {
    const point = mapPoint(event);
    if (!point || !activeTabId) return;
    void run('scroll', { tabId: activeTabId, x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY });
  }, [mapPoint, run, activeTabId]);

  const handleSurfaceKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (!activeTabId) return;
    const combo = specialKeyFor(event);
    if (combo) {
      event.preventDefault();
      void run('key', { tabId: activeTabId, key: combo });
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void run('type', { tabId: activeTabId, text: event.key });
    }
  }, [activeTabId, run]);

  const handleScreenshot = React.useCallback(() => {
    void guard(() => run('screenshot', { tabId: activeTabId ?? undefined }));
  }, [guard, run, activeTabId]);

  const handleToggleRecording = React.useCallback(() => {
    if (recording?.active) {
      void guard(() => run('recording.stop', {}));
    } else {
      void guard(() => run('recording.start', { tabId: activeTabId ?? undefined }));
    }
  }, [recording, guard, run, activeTabId]);

  const handleViewport = React.useCallback((preset: BrowserViewportPreset) => {
    if (!activeTabId) return;
    void guard(() => run('viewport', { tabId: activeTabId, preset }));
  }, [guard, run, activeTabId]);

  const tabItems = React.useMemo(() => tabs.map((tab) => ({
    id: tab.id,
    label: tab.title || tab.url || t('agentBrowser.tab.untitled'),
    title: tab.url || tab.title,
    icon: <Icon name="global" className="size-4" />,
    closeLabel: t('agentBrowser.tab.close'),
  })), [tabs, t]);

  if (hydrated && !supported) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="global" className="size-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t('agentBrowser.unsupported.title')}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t('agentBrowser.unsupported.description')}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--surface-background)]">
      <div className="flex h-10 items-center gap-1 border-b border-border px-2">
        <div className="min-w-0 flex-1">
          {tabs.length > 0 ? (
            <SortableTabsStrip
              items={tabItems}
              activeId={activeTabId}
              onSelect={handleSelectTab}
              onClose={handleCloseTab}
              layoutMode="scrollable"
              variant="default"
              className="h-8 bg-transparent"
            />
          ) : (
            <span className="pl-1 typography-micro text-muted-foreground">{t('agentBrowser.empty.noTabs')}</span>
          )}
        </div>
        <Button type="button" size="icon" variant="ghost" onClick={handleNewTab} disabled={busy} title={t('agentBrowser.actions.newTab')} aria-label={t('agentBrowser.actions.newTab')}>
          <Icon name="add" className="size-4" />
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button type="button" size="icon" variant="ghost" onClick={handleReload} disabled={busy || !activeTab} title={t('agentBrowser.actions.reload')} aria-label={t('agentBrowser.actions.reload')}>
          <Icon name="restart" className="size-4" />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            handleNavigate();
          }}
        >
          <input
            type="text"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder={t('agentBrowser.urlBar.placeholder')}
            className="h-8 w-full rounded-md border border-border bg-[var(--surface-input)] px-3 typography-ui text-foreground outline-none focus:border-[var(--interactive-border-hover)]"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </form>
        <Button type="button" size="sm" variant="secondary" onClick={handleNavigate} disabled={busy || !urlInput.trim()} title={t('agentBrowser.actions.go')}>
          <Icon name="arrow-right" className="size-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        {VIEWPORT_PRESETS.map(({ preset, icon, labelKey }) => (
          <Button
            key={preset}
            type="button"
            size="xs"
            variant="chip"
            aria-pressed={activeTab?.viewport.preset === preset}
            onClick={() => handleViewport(preset)}
            disabled={busy || !activeTab}
            className="gap-1"
          >
            <Icon name={icon} className="size-3.5" />
            <span>{t(labelKey)}</span>
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" size="xs" variant="ghost" onClick={handleScreenshot} disabled={busy || !activeTab} className="gap-1" title={t('agentBrowser.actions.screenshot')}>
            <Icon name="camera" className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="xs"
            variant={recording?.active ? 'destructive' : 'ghost'}
            onClick={handleToggleRecording}
            disabled={busy || !activeTab}
            className="gap-1"
            title={recording?.active ? t('agentBrowser.actions.stopRecording') : t('agentBrowser.actions.startRecording')}
          >
            <Icon name={recording?.active ? 'stop' : 'record-circle'} className="size-3.5" />
            {recording?.active ? <span>{t('agentBrowser.recording.active')}</span> : null}
          </Button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden bg-[var(--surface-sunken)]">
        {activeTab ? (
          <div
            role="application"
            tabIndex={0}
            aria-label={t('agentBrowser.preview.aria')}
            className="flex h-full w-full items-center justify-center outline-none"
            onPointerDown={handleSurfaceClick}
            onWheel={handleSurfaceWheel}
            onKeyDown={handleSurfaceKeyDown}
          >
            {frame ? (
              <div className="relative max-h-full max-w-full" style={{ aspectRatio: `${activeTab.viewport.width} / ${activeTab.viewport.height}` }}>
                <img ref={imageRef} src={frame} alt="" className="h-full w-full select-none object-contain" draggable={false} />
                {cursor?.visible ? (
                  <span
                    className="pointer-events-none absolute z-10 -ml-2 -mt-2 size-4 rounded-full border-2 border-[var(--primary-background)] bg-[var(--primary-background)]/30"
                    style={{ left: `${(cursor.x / activeTab.viewport.width) * 100}%`, top: `${(cursor.y / activeTab.viewport.height) * 100}%` }}
                  />
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Icon name="global" className={cn('size-10', activeTab.loading && 'opacity-60')} />
                <span className="typography-micro">
                  {connection === 'open' ? t('agentBrowser.preview.waitingFrame') : t('agentBrowser.preview.connecting')}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="global" className="size-12 text-muted-foreground/50" />
            <div className="typography-ui-header text-foreground">{t('agentBrowser.empty.title')}</div>
            <div className="max-w-sm typography-micro text-muted-foreground">{t('agentBrowser.empty.description')}</div>
            <Button type="button" size="sm" variant="secondary" onClick={handleNewTab} disabled={busy}>
              <Icon name="add" className="size-4" />
              <span>{t('agentBrowser.actions.newTab')}</span>
            </Button>
          </div>
        )}
        {error ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error-foreground)]">
            <span className="truncate">{error}</span>
          </div>
        ) : null}
      </div>

      {artifacts.length > 0 ? (
        <div className="flex items-center gap-2 overflow-x-auto border-t border-border px-2 py-2 [scrollbar-width:thin]">
          <span className="shrink-0 typography-micro text-muted-foreground">{t('agentBrowser.artifacts.title')}</span>
          {artifacts.slice(0, 12).map((artifact) => (
            <ArtifactThumb key={artifact.id} id={artifact.id} kind={artifact.kind} onOpen={setPreview} />
          ))}
        </div>
      ) : null}

      {preview ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            URL.revokeObjectURL(preview);
            setPreview(null);
          }}
        >
          <img src={preview} alt={t('agentBrowser.artifacts.screenshot')} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      ) : null}
    </div>
  );
};
