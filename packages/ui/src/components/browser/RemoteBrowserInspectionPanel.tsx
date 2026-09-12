import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { RemoteSurfaceClient } from '@/lib/browser/remoteSurface';
import type { BrowserInspectionMode } from './RemoteBrowserChrome';
import { RemoteBrowserInspector } from './RemoteBrowserInspector';
import { RemoteBrowserDevTools } from './RemoteBrowserDevTools';

type Props = {
  readonly client: RemoteSurfaceClient;
  readonly mode: Exclude<BrowserInspectionMode, null>;
  readonly onModeChange: (mode: BrowserInspectionMode) => void;
  readonly maximized: boolean;
  readonly onMaximizedChange: (maximized: boolean) => void;
  readonly returnFocus: React.RefObject<HTMLButtonElement | null>;
};

export function RemoteBrowserInspectionPanel({ client, mode, onModeChange, maximized, onMaximizedChange, returnFocus }: Props) {
  const { t } = useI18n();
  const panel = React.useRef<HTMLElement>(null);
  const pointer = React.useRef<{ id: number; origin: number; height: number; fraction: number } | null>(null);
  const [fraction, setFraction] = React.useState(60);
  const resize = (next: number) => setFraction(Math.max(20, Math.min(80, next)));
  const close = () => { onModeChange(null); returnFocus.current?.focus({ preventScroll: true }); };
  return <section ref={panel} aria-label={t('contextPanel.browser.remote.inspectMode')}
    className="relative flex min-h-0 shrink-0 flex-col border-t border-border bg-background"
    style={{ flexBasis: `${maximized ? 100 : fraction}%` }}>
    {!maximized ? <div role="separator" tabIndex={0} aria-orientation="horizontal"
      aria-label={t('contextPanel.browser.remote.resizeInspector')} aria-valuemin={20} aria-valuemax={80} aria-valuenow={fraction}
      className="absolute inset-x-0 -top-1 z-10 h-2 touch-none cursor-row-resize outline-none hover:bg-interactive-hover focus-visible:bg-interactive-active"
      onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        resize(event.key === 'Home' ? 20 : event.key === 'End' ? 80 : fraction + (event.key === 'ArrowUp' ? 5 : -5));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const height = panel.current?.parentElement?.getBoundingClientRect().height;
        if (!height) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current = { id: event.pointerId, origin: event.clientY, height, fraction };
      }}
      onPointerMove={(event) => {
        const active = pointer.current;
        if (active?.id === event.pointerId) resize(active.fraction + (active.origin - event.clientY) / active.height * 100);
      }}
      onPointerUp={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        pointer.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { pointer.current = null; }} /> : null}
    <div className="flex min-w-0 shrink-0 items-center justify-between gap-1 border-b border-border px-2 py-1">
      <span className="min-w-0 truncate typography-micro text-muted-foreground">
        {t(mode === 'devtools' ? 'contextPanel.browser.remote.devTools' : 'contextPanel.browser.remote.simpleInspector')}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="xs" variant="ghost" aria-label={t(maximized ? 'contextPanel.browser.remote.restoreInspector' : 'contextPanel.browser.remote.maximizeInspector')}
          onClick={() => onMaximizedChange(!maximized)}><Icon name={maximized ? 'fullscreen-exit' : 'fullscreen'} className="size-4" /></Button>
        <Button size="xs" variant="ghost" aria-label={t('contextPanel.browser.remote.inspector.close')} onClick={close}>
          <Icon name="close" className="size-4" />
        </Button>
      </div>
    </div>
    {mode === 'devtools' ? <RemoteBrowserDevTools devtools={client.devtools} onUseSimpleInspector={() => onModeChange('simple')} />
      : <RemoteBrowserInspector inspector={client.inspector} returnFocus={returnFocus} fill showCloseButton={false} />}
  </section>;
}
