import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { RemoteSurfaceDevTools } from '@/lib/browser/remoteSurfaceDevTools';
import { DEVTOOLS_COMMAND_BYTES, type DevToolsErrorCode } from '@/lib/browser/remoteSurfaceDevToolsProtocol';
import { createRemoteDevToolsThemeMessage } from './remoteDevToolsTheme';

const FRONTEND_LOAD_TIMEOUT_MS = 60_000;

const frontendMessage = z.object({
  type: z.enum(['openchamber-devtools-ready', 'openchamber-devtools-themed', 'openchamber-devtools-theme-rejected',
    'openchamber-devtools-loaded']), devtoolsId: z.string().max(128),
  attachmentRequestId: z.string().max(128),
});
const command = z.string().min(1).max(DEVTOOLS_COMMAND_BYTES);
const errorKeys = {
  DEVTOOLS_INVALID_REQUEST: 'contextPanel.browser.remote.devtoolsInvalidRequest',
  DEVTOOLS_START_FAILED: 'contextPanel.browser.remote.devtoolsStartFailed',
  DEVTOOLS_PROTOCOL_REJECTED: 'contextPanel.browser.remote.devtoolsProtocolRejected',
  DEVTOOLS_CONTROL_LOST: 'contextPanel.browser.remote.devtoolsControlLost',
  DEVTOOLS_CONNECTION_CLOSED: 'contextPanel.browser.remote.devtoolsConnectionClosed',
  DEVTOOLS_MESSAGE_TOO_LARGE: 'contextPanel.browser.remote.devtoolsMessageTooLarge',
  DEVTOOLS_BACKPRESSURE: 'contextPanel.browser.remote.devtoolsBackpressure',
  DEVTOOLS_EXCLUSIVE_CONTEXT_REQUIRED: 'contextPanel.browser.remote.devtoolsExclusive',
} satisfies Record<DevToolsErrorCode, I18nKey>;

type Props = { readonly devtools: RemoteSurfaceDevTools; readonly onUseSimpleInspector: () => void };

export function RemoteBrowserDevTools({ devtools, onUseSimpleInspector }: Props) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const state = React.useSyncExternalStore(devtools.subscribe, devtools.getState, devtools.getState);
  const iframe = React.useRef<HTMLIFrameElement>(null);
  const portRef = React.useRef<MessagePort | null>(null);
  const themeMessage = React.useMemo(() => createRemoteDevToolsThemeMessage(currentTheme), [currentTheme]);
  const themeMessageRef = React.useRef(themeMessage);
  themeMessageRef.current = themeMessage;
  const [frontendUrl, setFrontendUrl] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    setFrontendUrl(null);
    setLoaded(false);
    if (state.phase !== 'ready' || !state.frontendPath || !state.devtoolsId || !state.attachment) return;
    const lifecycle = new AbortController();
    const devtoolsId = state.devtoolsId;
    const attachmentRequestId = state.attachment.attachmentRequestId;
    let disposeAssets: (() => void) | null = null;
    let port: MessagePort | null = null;
    let expectedOrigin: string | null = null;
    let frontendLoaded = false;
    let frontendThemed = false;
    const fail = () => {
      if (lifecycle.signal.aborted) return;
      setLoadFailed(true);
      devtools.setOpen(false);
    };
    const timeout = setTimeout(fail, FRONTEND_LOAD_TIMEOUT_MS);
    const completeLoading = () => {
      if (!port || !frontendLoaded || !frontendThemed) return;
      clearTimeout(timeout);
      setLoaded(true);
    };
    const handleReady = (event: MessageEvent) => {
      if (lifecycle.signal.aborted || event.source !== iframe.current?.contentWindow
        || event.origin !== expectedOrigin) return;
      const message = frontendMessage.safeParse(event.data);
      if (!message.success || message.data.devtoolsId !== devtoolsId
        || message.data.attachmentRequestId !== attachmentRequestId) return;
      if (message.data.type === 'openchamber-devtools-theme-rejected') {
        fail();
        return;
      }
      if (message.data.type === 'openchamber-devtools-themed') {
        frontendThemed = true;
        completeLoading();
        return;
      }
      if (message.data.type === 'openchamber-devtools-loaded') {
        frontendLoaded = true;
        completeLoading();
        return;
      }
      if (port) return;
      const frameWindow = iframe.current?.contentWindow;
      if (!frameWindow || !expectedOrigin) return;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (incoming) => {
        if (devtools.getState().devtoolsId !== devtoolsId) return;
        const parsed = command.safeParse(incoming.data);
        if (!parsed.success) { fail(); return; }
        devtools.sendMessage(parsed.data);
      };
      port.onmessageerror = fail;
      port.start();
      portRef.current = port;
      frameWindow.postMessage({ type: 'openchamber-devtools-connect', devtoolsId, attachmentRequestId },
        expectedOrigin, [channel.port2]);
      const initialTheme = themeMessageRef.current;
      if (initialTheme) port.postMessage(initialTheme);
      else fail();
      devtools.setMessageHandler((data) => {
        if (!lifecycle.signal.aborted && devtools.getState().devtoolsId === devtoolsId) port?.postMessage(data);
      });
      completeLoading();
    };
    window.addEventListener('message', handleReady);
    const prepare = async () => {
      const path = state.frontendPath;
      if (!path) return;
      let url: URL;
      if (getActiveRelayTunnel()) {
        const { openDevToolsAssetProxy } = await import('@/lib/browser/devtoolsAssetProxy');
        const assets = await openDevToolsAssetProxy(path, lifecycle.signal);
        disposeAssets = assets.dispose;
        url = new URL(assets.frontendUrl, window.location.href);
      } else url = new URL(getRuntimeUrlResolver().api(path), window.location.href);
      if (lifecycle.signal.aborted) { disposeAssets?.(); return; }
      expectedOrigin = url.origin;
      url.searchParams.set('parentOrigin', window.location.origin);
      url.searchParams.set('devtoolsId', devtoolsId);
      url.searchParams.set('attachmentRequestId', attachmentRequestId);
      setLoadFailed(false);
      setFrontendUrl(url.toString());
    };
    void prepare().catch(fail);
    return () => {
      lifecycle.abort();
      clearTimeout(timeout);
      window.removeEventListener('message', handleReady);
      devtools.setMessageHandler(null);
      if (portRef.current === port) portRef.current = null;
      port?.close();
      disposeAssets?.();
    };
  }, [devtools, state.attachment, state.devtoolsId, state.frontendPath, state.phase]);

  React.useEffect(() => {
    if (themeMessage) portRef.current?.postMessage(themeMessage);
  }, [themeMessage]);

  const error = state.errorCode ? t(errorKeys[state.errorCode])
    : loadFailed ? t('contextPanel.browser.remote.devtoolsLoadFailed') : null;
  if (error) return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4 text-center">
    <p role="alert" className="typography-ui-label text-muted-foreground">{error}</p>
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" onClick={() => { setLoadFailed(false); devtools.setOpen(true); }}>
        {t('contextPanel.browser.remote.devtoolsRetry')}
      </Button>
      <Button variant="outline" size="sm" onClick={onUseSimpleInspector}>{t('contextPanel.browser.remote.simpleInspector')}</Button>
    </div>
  </div>;

  return <div className="relative min-h-0 flex-1 overflow-hidden">
    {frontendUrl ? <iframe ref={iframe} src={frontendUrl} title={t('contextPanel.browser.remote.devTools')}
      className="h-full w-full border-0" allow="clipboard-read; clipboard-write" onError={() => {
        setLoadFailed(true); devtools.setOpen(false);
      }} /> : null}
    {!loaded ? <div role="status" className="absolute inset-0 flex items-center justify-center bg-background p-4 typography-micro text-muted-foreground">
      {t('contextPanel.browser.remote.devtoolsLoading')}
    </div> : null}
  </div>;
}
