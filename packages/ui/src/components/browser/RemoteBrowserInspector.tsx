import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { RemoteSurfaceInspector } from '@/lib/browser/remoteSurfaceInspector';
import type { SurfaceInspectorScope } from '@/lib/browser/remoteSurfaceInspectorProtocol';
import { RemoteBrowserConsole } from './RemoteBrowserConsole';
import { RemoteBrowserNetwork } from './RemoteBrowserNetwork';
import { remoteInspectorErrorKeys } from './remoteBrowserInspectorMessages';

type Props = {
  readonly inspector: RemoteSurfaceInspector;
  readonly returnFocus?: React.RefObject<HTMLButtonElement | null>;
  readonly fill?: boolean;
  readonly showCloseButton?: boolean;
};

export function RemoteBrowserInspector({ inspector, returnFocus, fill = false, showCloseButton = true }: Props) {
  const { t } = useI18n();
  const state = React.useSyncExternalStore(inspector.subscribe, inspector.getState, inspector.getState);
  const [tab, setTab] = React.useState<SurfaceInspectorScope>('console');
  const [filter, setFilter] = React.useState('');
  const [clearRevision, setClearRevision] = React.useState(0);
  const id = React.useId();
  const consoleTab = React.useRef<HTMLButtonElement>(null);
  const networkTab = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (state.open) consoleTab.current?.focus({ preventScroll: true });
    else { setTab('console'); setFilter(''); }
  }, [state.open]);

  const tabKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'console' : event.key === 'End' ? 'network' : tab === 'console' ? 'network' : 'console';
    setTab(next);
    (next === 'console' ? consoleTab : networkTab).current?.focus({ preventScroll: true });
  };

  if (!state.open) return null;
  const capturing = state.phase === 'capturing';
  const dropped = tab === 'console' ? state.droppedConsole : state.droppedNetwork;
  const errorKey = state.errorCode === 'TIMEOUT' ? 'contextPanel.browser.remote.inspector.errorCapture'
    : state.errorCode ? remoteInspectorErrorKeys[state.errorCode] : null;

  return <section role="region" aria-label={t('contextPanel.browser.remote.inspector.title')}
    className={`flex min-h-0 flex-col bg-background ${fill ? 'flex-1' : 'h-3/5 shrink-0 border-t border-border'}`}>
    <div className="shrink-0 space-y-1 border-b border-border p-2">
      <div className="flex items-center justify-between gap-1">
        <div role="tablist" aria-label={t('contextPanel.browser.remote.inspector.title')} className="flex items-center gap-1" onKeyDown={tabKeyDown}>
          <Button ref={consoleTab} role="tab" id={`${id}-console-tab`} aria-controls={`${id}-console-panel`}
            aria-selected={tab === 'console'} tabIndex={tab === 'console' ? 0 : -1} size="xs"
            variant={tab === 'console' ? 'secondary' : 'ghost'} onClick={() => setTab('console')}>
            {t('contextPanel.browser.remote.inspector.console')}
          </Button>
          <Button ref={networkTab} role="tab" id={`${id}-network-tab`} aria-controls={`${id}-network-panel`}
            aria-selected={tab === 'network'} tabIndex={tab === 'network' ? 0 : -1} size="xs"
            variant={tab === 'network' ? 'secondary' : 'ghost'} onClick={() => setTab('network')}>
            {t('contextPanel.browser.remote.inspector.network')}
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" disabled={!capturing} onClick={() => {
            inspector.clear(tab);
            if (tab === 'console') setClearRevision((revision) => revision + 1);
          }}>{t('contextPanel.browser.remote.inspector.clear')}</Button>
          {showCloseButton ? <Button variant="ghost" size="xs" aria-label={t('contextPanel.browser.remote.inspector.close')} onClick={() => {
            inspector.setOpen(false);
            returnFocus?.current?.focus({ preventScroll: true });
          }}><Icon name="close" className="size-4" /></Button> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 typography-micro text-muted-foreground" role="status">
        <span className={capturing ? 'text-[var(--status-success)]' : undefined}>
          {t(capturing ? 'contextPanel.browser.remote.inspector.capturing'
            : state.phase === 'starting' ? 'contextPanel.browser.remote.inspector.starting' : 'contextPanel.browser.remote.inspector.errorUnavailable')}
        </span>
        {dropped > 0 ? <span>{t('contextPanel.browser.remote.inspector.dropped', { count: dropped })}</span> : null}
      </div>
      <p className="typography-micro text-muted-foreground">{t('contextPanel.browser.remote.inspector.captureHint')}</p>
      {errorKey ? <p role="alert" className="typography-micro text-[var(--status-error)]">{t(errorKey)}</p> : null}
      <Input type="search" value={filter} onChange={(event) => setFilter(event.currentTarget.value)}
        aria-label={t('contextPanel.browser.remote.inspector.filterAria')}
        placeholder={t('contextPanel.browser.remote.inspector.filterPlaceholder')} />
    </div>
    <div id={`${id}-console-panel`} role="tabpanel" aria-labelledby={`${id}-console-tab`}
      hidden={tab !== 'console'} className={tab === 'console' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <RemoteBrowserConsole inspector={inspector} entries={state.console} captureId={capturing ? state.captureId : null}
        active={tab === 'console'} filter={filter} clearRevision={clearRevision} />
    </div>
    {tab === 'network' ? <div id={`${id}-network-panel`} role="tabpanel" aria-labelledby={`${id}-network-tab`} className="flex min-h-0 flex-1 flex-col">
      <RemoteBrowserNetwork inspector={inspector} entries={state.network} captureId={capturing ? state.captureId : null} filter={filter} />
    </div> : null}
  </section>;
}
