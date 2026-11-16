import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSection } from '@/components/ui/MobileSheetList';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { cn } from '@/lib/utils';

import { MobileConnectionDebugPanel } from './MobileConnectionDebugPanel';
import { MobileConnectionHeaders } from './MobileConnectionHeaders';
import { useDebugPanelLongPress } from './mobileConnectionDebug';
import { mobileConnectionInputClass, mobileInputKeyboardProps } from './mobileConnectionUi';
import {
  connectionDisplayUrl,
  isActiveRuntimeConnection,
  loadMobileConnectionHeaders,
  useMobileConnection,
  type MobileSavedConnection,
} from './mobileConnections';
import { isQrScanSupported, parseConnectionPayload, scanConnectionQr } from './mobileQrScan';
import { MobileQrConnectionLoading, MobileQrScannerOverlay } from './MobileQrScannerOverlay';
import { buildMobileHeaderValues, createMobileHeaderDrafts, type MobileHeaderDraft } from './mobileRequestHeaders';

export type MobileConnectionNotice = {
  kind: 'unreachable' | 'relay-limit' | 'auth-expired';
  label: string;
};

type Props =
  /** The app's first screen: nothing is connected yet, a new address connects at once. */
  | { mode: 'welcome'; onConnected: () => void; notice?: MobileConnectionNotice | null }
  /** Inside the app: one instance is live, a new address is saved for later. */
  | { mode: 'instances'; onConnected: () => void; onActiveConnectionDeleted: () => void };

type FormTarget = { kind: 'add' } | { kind: 'edit'; id: string };

const isRelayOnly = (connection: { candidates: ReadonlyArray<{ kind: string }> }): boolean =>
  !connection.candidates.some((candidate) => candidate.kind === 'direct');

const hasAnyHeader = (headers: MobileHeaderDraft[]): boolean =>
  headers.some(({ name, value }) => name.trim() || value.trim());

/**
 * The saved servers, on the first screen and in Instances. With none saved the
 * screen introduces the app and offers the two ways in. With servers it leads
 * with the one the user comes back to, the others below it, and adding within
 * thumb's reach. Everything else about a server is in its sheet.
 */
export const MobileConnectionsView: React.FC<Props> = (props) => {
  const { mode, onConnected } = props;
  const { t } = useI18n();
  const conn = useMobileConnection(onConnected);
  const {
    connections, isBusy, isPasswordBusy, error, pendingConnection,
    connect, submitPassword, cancelPassword, saveConnection, removeConnection, setError,
  } = conn;

  const [formTarget, setFormTarget] = React.useState<FormTarget | null>(null);
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [headers, setHeaders] = React.useState<MobileHeaderDraft[]>([]);
  const [isSaving, setIsSaving] = React.useState(false);
  const editRequestRef = React.useRef(0);

  const [actionsId, setActionsId] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const actionsConnection = actionsId ? connections.find((connection) => connection.id === actionsId) ?? null : null;
  const editingConnection = formTarget?.kind === 'edit'
    ? connections.find((connection) => connection.id === formTarget.id) ?? null
    : null;
  // A relay-only connection has no address or typed token to edit; only its name.
  const editingRelayOnly = editingConnection ? isRelayOnly(editingConnection) : false;

  // Which row is being connected to, for its spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState('');

  const [isScanning, setIsScanning] = React.useState(false);
  const scanBlink = useWaitingBlink(isScanning);
  const [isCompletingScan, setIsCompletingScan] = React.useState(false);
  const scanAbortRef = React.useRef<AbortController | null>(null);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);

  // Hidden diagnostics: long-press the logo or the lead card to open the
  // connection event log, reachable even when bounced back to this screen.
  const [debugOpen, setDebugOpen] = React.useState(false);
  const debugLongPress = useDebugPanelLongPress(React.useCallback(() => setDebugOpen(true), []));

  // Populate and clear the form imperatively, on the tap: an effect keyed on the
  // connection would re-fire on any list churn and overwrite what is being typed.
  const closeForm = React.useCallback(() => {
    editRequestRef.current += 1;
    setFormTarget(null);
    setUrl('');
    setLabel('');
    setClientToken('');
    setHeaders([]);
    setError(null);
  }, [setError]);

  const openAddForm = () => {
    editRequestRef.current += 1;
    setError(null);
    setFormTarget({ kind: 'add' });
  };

  const openEditForm = (connection: MobileSavedConnection) => {
    const request = ++editRequestRef.current;
    setActionsId(null);
    void loadMobileConnectionHeaders(connection.id).then((config) => {
      if (request !== editRequestRef.current) return;
      setFormTarget({ kind: 'edit', id: connection.id });
      setUrl(isRelayOnly(connection) ? '' : config?.url || connectionDisplayUrl(connection));
      setLabel(connection.label);
      setClientToken(connection.clientToken || '');
      setHeaders(createMobileHeaderDrafts(config?.values));
      setError(null);
    }).catch(() => {
      if (request === editRequestRef.current) setError(t('mobile.connect.headers.error'));
    });
  };

  const handleUrlChange = (value: string) => {
    // The first screen takes a pasted pairing link (openchamber://connect?...) in
    // the URL field and splits it back into the server URL and token.
    if (mode === 'welcome' && /^openchamber:\/\//i.test(value.trim())) {
      const payload = parseConnectionPayload(value);
      if (payload) {
        if ('pairing' in payload) {
          void conn.redeemPairingConnection(payload.pairing);
          return;
        }
        setUrl(payload.url);
        if (payload.label) setLabel(payload.label);
        if (payload.clientToken) setClientToken(payload.clientToken);
        return;
      }
    }
    setUrl(value);
  };

  const submitForm = (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === 'welcome' && formTarget?.kind === 'add') {
      void connect({
        url,
        clientToken,
        label,
        requestHeaders: hasAnyHeader(headers) ? buildMobileHeaderValues(headers) : undefined,
      });
      return;
    }
    if (isSaving) return;
    setIsSaving(true);
    // The id is what makes this an edit: saveConnection uses it to keep the
    // instance's relay and https candidates and the Keychain token they key.
    void saveConnection({
      id: editingConnection?.id,
      url,
      label,
      clientToken,
      requestHeaders: editingRelayOnly ? undefined : buildMobileHeaderValues(headers),
    }).then((saved) => {
      if (saved) closeForm();
    }).finally(() => setIsSaving(false));
  };

  const handleScan = async () => {
    if (scanAbortRef.current || isBusy) return;
    setError(null);
    setIsScanning(true);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    try {
      const result = await scanConnectionQr({ signal: controller.signal });
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
      switch (result.status) {
        case 'ok':
          // Legacy token QR. The form keeps the scanned values for a retry on the
          // first screen, and for review before saving in Instances.
          setUrl(result.url);
          if (result.label) setLabel(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          if (mode === 'welcome') {
            setIsCompletingScan(true);
            await connect({ url: result.url, clientToken: result.clientToken, label: result.label });
          } else {
            setFormTarget({ kind: 'add' });
          }
          break;
        case 'pairing':
          setIsCompletingScan(true);
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsCompletingScan(false);
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
    }
  };

  React.useEffect(() => () => {
    scanAbortRef.current?.abort();
    editRequestRef.current += 1;
  }, []);

  const connectTo = (connection: MobileSavedConnection) => {
    setConnectingId(connection.id);
    void connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
      .finally(() => setConnectingId(null));
  };

  const closeActions = () => {
    setActionsId(null);
    setConfirmingDelete(false);
  };

  const deleteConnection = (id: string) => {
    editRequestRef.current += 1;
    closeActions();
    if (formTarget?.kind === 'edit' && formTarget.id === id) closeForm();
    // Removing the active instance, or the last one, drops the user back to the
    // connect screen instead of leaving a stale, unbacked UI.
    const wasLast = connections.length === 1;
    void removeConnection(id).then((removed) => {
      if (!removed || mode !== 'instances') return;
      if (wasLast || isActiveRuntimeConnection(removed)) props.onActiveConnectionDeleted();
    });
  };

  const liveConnection = mode === 'instances' ? connections.find(isActiveRuntimeConnection) ?? null : null;
  // Saved connections are ordered by last use, so the first is the way back.
  const leadConnection = liveConnection ?? connections[0] ?? null;
  const otherConnections = connections.filter((connection) => connection !== leadConnection);
  const addressOf = (connection: MobileSavedConnection): string =>
    isRelayOnly(connection) ? t('mobile.connect.relay.badge') : connectionDisplayUrl(connection);
  const actionsButton = (connection: MobileSavedConnection, className?: string) => (
    <button
      type="button"
      aria-label={t('mobile.instances.actionsAria', { label: connection.label })}
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground touch-manipulation focus:outline-none active:bg-interactive-hover', className)}
      onClick={() => setActionsId(connection.id)}
    >
      <Icon name="more" className="size-4" />
    </button>
  );

  const noticeBanner = mode === 'welcome' && props.notice ? (
    <div role="status" className="flex items-center gap-2.5 rounded-lg bg-[var(--status-warning-background)] px-3 py-2.5">
      <Icon name={props.notice.kind === 'auth-expired' ? 'lock' : 'cloud-off'} className="size-4 shrink-0 text-[var(--status-warning)]" />
      <p className="min-w-0 flex-1 typography-meta text-foreground">
        {props.notice.kind === 'auth-expired'
          ? t('mobile.connect.notice.authExpired', { label: props.notice.label })
          : props.notice.kind === 'relay-limit'
            ? t('mobile.connect.notice.relayLimit', { label: props.notice.label })
            : t('mobile.connect.notice.unreachable', { label: props.notice.label })}
      </p>
    </div>
  ) : null;

  const errorLine = error && !formTarget
    ? <p className="px-1 text-center typography-meta text-[var(--status-error-text)]">{error}</p>
    : null;

  const logo = (size: number) => (
    <span {...debugLongPress} className="inline-flex select-none" style={{ touchAction: 'manipulation' }}>
      <OpenChamberLogo width={size} height={size} />
    </span>
  );

  const firstRun = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 px-2 pt-[10vh]">
        {logo(44)}
        <h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">{t('mobile.connect.firstRun.title')}</h1>
        <p className="typography-ui-label text-muted-foreground">{t('mobile.connect.firstRun.description')}</p>
      </div>
      <div className="mt-auto flex flex-col gap-3 pt-6">
        {noticeBanner}
        {errorLine}
        <div className={cn('grid gap-2', qrScanSupported && 'grid-cols-2')}>
          {qrScanSupported ? (
            <button
              type="button"
              disabled={isScanning || isBusy}
              className="oc-tile flex flex-col gap-6 rounded-xl p-3.5 text-start touch-manipulation focus:outline-none active:bg-interactive-hover disabled:opacity-60"
              onClick={() => void handleScan()}
            >
              <Icon name="scan-2" className={cn('size-5 text-muted-foreground', scanBlink)} />
              <span className="flex flex-col">
                <span className="typography-ui-label font-medium text-foreground">{isBusy ? t('mobile.connect.connecting') : t('mobile.connect.scanQr')}</span>
                <span className="typography-micro text-muted-foreground">{t('mobile.connect.firstRun.scanHint')}</span>
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="oc-tile flex flex-col gap-6 rounded-xl p-3.5 text-start touch-manipulation focus:outline-none active:bg-interactive-hover"
            onClick={openAddForm}
          >
            <Icon name="link" className="size-5 text-muted-foreground" />
            <span className="flex flex-col">
              <span className="typography-ui-label font-medium text-foreground">{t('mobile.connect.manual.toggle')}</span>
              <span className="typography-micro text-muted-foreground">{t('mobile.connect.firstRun.addressHint')}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );

  const leadCard = leadConnection ? (
    <section
      {...(mode === 'instances' ? debugLongPress : null)}
      aria-label={leadConnection.label}
      className="oc-tile relative flex flex-col rounded-xl p-4"
    >
      {actionsButton(leadConnection, 'absolute top-1.5 inset-e-1.5')}
      {liveConnection ? null : (
        <span className="pb-1 typography-micro text-muted-foreground">{t('mobile.connect.lastConnected')}</span>
      )}
      <h2 dir="auto" className="oc-ui-start-align truncate pe-8 typography-ui-header font-semibold text-foreground">{leadConnection.label}</h2>
      <p dir="ltr" className="oc-ui-start-align truncate pe-8 typography-meta text-muted-foreground">{addressOf(leadConnection)}</p>
      <div className="flex h-9 items-center pt-3">
        {/* Live already: what would be the button says so, in the button's place. */}
        {liveConnection ? (
          <span className="flex items-center gap-2 typography-meta text-foreground">
            <span className="size-1.5 rounded-full bg-[var(--status-success)]" aria-hidden />
            {isRelayModeActive() ? t('mobile.instances.status.connectedRelay') : t('mobile.instances.status.connectedDirect')}
          </span>
        ) : (
          <Button type="button" disabled={isBusy} onClick={() => connectTo(leadConnection)}>
            {connectingId === leadConnection.id ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
            {connectingId === leadConnection.id ? t('mobile.connect.connecting') : t('mobile.connect.connectButton')}
          </Button>
        )}
      </div>
    </section>
  ) : null;

  const otherList = otherConnections.length > 0 ? (
    <MobileSheetSection title={t('mobile.connect.saved.other')}>
      {otherConnections.map((connection) => {
        const connecting = connectingId === connection.id;
        return (
          <MobileSheetRow
            key={connection.id}
            disabled={isBusy}
            meta={connecting ? <Icon name="loader-4" className="size-4 animate-spin" /> : undefined}
            action={actionsButton(connection)}
            onClick={() => connectTo(connection)}
          >
            <span className="block py-1.5">
              <span dir="auto" className="oc-ui-start-align block truncate">{connection.label}</span>
              <span className="block truncate typography-micro font-normal text-muted-foreground">
                {connecting ? t('mobile.connect.connecting') : addressOf(connection)}
              </span>
            </span>
          </MobileSheetRow>
        );
      })}
    </MobileSheetSection>
  ) : null;

  const addActions = (
    <div className="flex shrink-0 flex-col items-center gap-1 pt-3">
      {errorLine}
      {qrScanSupported ? (
        <>
          <Button type="button" variant="outline" disabled={isScanning || isBusy} onClick={() => void handleScan()}>
            <Icon name="scan-2" className={cn('size-4', scanBlink)} />
            {t('mobile.connect.scanQr')}
          </Button>
          <button
            type="button"
            className="min-h-9 px-2 typography-meta text-muted-foreground touch-manipulation focus:outline-none active:text-foreground"
            onClick={openAddForm}
          >
            {t(mode === 'welcome' ? 'mobile.connect.manual.toggle' : 'mobile.instances.addManual')}
          </button>
        </>
      ) : (
        <Button type="button" variant="outline" onClick={openAddForm}>
          <Icon name="link" className="size-4" />
          {t(mode === 'welcome' ? 'mobile.connect.manual.toggle' : 'mobile.instances.addManual')}
        </Button>
      )}
    </div>
  );

  const passwordPrompt = pendingConnection ? (
    <form className="flex w-full flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submitPassword(password); }}>
      <div className="oc-tile rounded-xl p-4">
        <p dir="auto" className="oc-ui-start-align truncate typography-ui-header font-semibold text-foreground">{pendingConnection.label}</p>
        <p className="truncate typography-meta text-muted-foreground">
          {isRelayOnly(pendingConnection) ? t('mobile.connect.relay.badge') : connectionDisplayUrl(pendingConnection)}
        </p>
      </div>
      <input
        {...mobileInputKeyboardProps}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder={t('mobile.connect.password.placeholder')}
        aria-label={t('mobile.connect.password.label')}
        type="password"
        autoFocus
        className={mobileConnectionInputClass}
      />
      {error ? <p className="px-1 typography-meta text-[var(--status-error-text)]">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => { setPassword(''); cancelPassword(); }}>
          {t('mobile.connect.cancelPassword')}
        </Button>
        <Button type="submit" disabled={isPasswordBusy || !password.trim()}>
          {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
        </Button>
      </div>
    </form>
  ) : null;

  const body = passwordPrompt ?? (leadConnection ? (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {noticeBanner}
      {leadCard}
      <div className="mt-auto">{otherList}</div>
    </div>
  ) : firstRun);

  const forms = (
    <>
      {isScanning ? <MobileQrScannerOverlay onCancel={() => scanAbortRef.current?.abort()} /> : null}
      {isCompletingScan ? <MobileQrConnectionLoading /> : null}
      {debugOpen ? <MobileConnectionDebugPanel onClose={() => setDebugOpen(false)} /> : null}

      <MobileOverlayPanel open={actionsConnection !== null} title={actionsConnection?.label ?? ''} onClose={closeActions}>
        {actionsConnection ? (
          <>
            <MobileSheetRow icon="edit" disabled={isSaving} onClick={() => openEditForm(actionsConnection)}>
              {t('mobile.instances.edit')}
            </MobileSheetRow>
            <MobileSheetRow
              icon="delete-bin"
              destructive
              disabled={isSaving}
              onClick={() => {
                if (confirmingDelete) deleteConnection(actionsConnection.id);
                else setConfirmingDelete(true);
              }}
            >
              {confirmingDelete
                ? t('mobile.instances.confirmDeleteAria', { label: actionsConnection.label })
                : t('mobile.instances.delete')}
            </MobileSheetRow>
          </>
        ) : null}
      </MobileOverlayPanel>

      <MobileOverlayPanel
        open={formTarget !== null && !pendingConnection}
        title={formTarget?.kind === 'edit'
          ? t('mobile.instances.editTitle')
          : t(mode === 'welcome' ? 'mobile.connect.manual.toggle' : 'mobile.instances.addTitle')}
        onClose={closeForm}
      >
        <form className="flex flex-col gap-3 px-1 pb-1" onSubmit={submitForm}>
          {editingRelayOnly ? null : (
            <label className="flex flex-col gap-1.5">
              <span className="px-1 typography-meta text-muted-foreground">{t('mobile.connect.url.label')}</span>
              <input
                {...mobileInputKeyboardProps}
                value={url}
                onChange={(event) => handleUrlChange(event.target.value)}
                placeholder={t('mobile.connect.url.placeholder')}
                type="url"
                inputMode="url"
                autoCapitalize="none"
                className={mobileConnectionInputClass}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="px-1 typography-meta text-muted-foreground">{t('mobile.instances.label.label')}</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('mobile.instances.label.placeholder')}
              autoComplete="off"
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              className={mobileConnectionInputClass}
            />
          </label>
          {editingRelayOnly ? null : (
            <label className="flex flex-col gap-1.5">
              <span className="px-1 typography-meta text-muted-foreground">{t('mobile.connect.token.label')}</span>
              <input
                {...mobileInputKeyboardProps}
                value={clientToken}
                onChange={(event) => setClientToken(event.target.value)}
                placeholder={t('mobile.connect.token.placeholder')}
                autoCapitalize="none"
                className={mobileConnectionInputClass}
              />
              <span className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</span>
            </label>
          )}
          {editingRelayOnly ? null : <MobileConnectionHeaders value={headers} onChange={setHeaders} disabled={isSaving || isBusy} />}
          {error ? <p className="px-1 typography-meta text-[var(--status-error-text)]">{error}</p> : null}
          <div className="flex justify-end">
            {mode === 'welcome' && formTarget?.kind === 'add' ? (
              <Button type="submit" disabled={isBusy || isScanning || !url.trim()}>
                {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.connectButton')}
              </Button>
            ) : (
              <Button type="submit" disabled={isSaving}>
                {editingConnection ? t('mobile.instances.saveEdit') : t('mobile.instances.saveNew')}
              </Button>
            )}
          </div>
        </form>
      </MobileOverlayPanel>
    </>
  );

  if (mode === 'instances') {
    return (
      <>
        {forms}
        <div className="flex h-full flex-col overflow-hidden">
          <ScrollableOverlay outerClassName="min-h-0 flex-1" className="flex min-h-full flex-col px-3 py-3" disableHorizontal>
            {body}
          </ScrollableOverlay>
          {pendingConnection || !leadConnection ? null : <div className="px-3 pb-3">{addActions}</div>}
        </div>
      </>
    );
  }

  return (
    <>
      {forms}
      <main className="oc-keyboard-fill-screen flex min-h-dvh flex-col overflow-y-auto bg-background pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+16px)] pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+16px)] text-foreground"
        // Clear the screen's side insets too: the notch in landscape, the status
        // bar column on the right of iPhone Duo.
        style={{
          paddingLeft: 'calc(var(--oc-safe-area-left, 0px) + 1rem)',
          paddingRight: 'calc(var(--oc-safe-area-right, 0px) + 1rem)',
        }}
      >
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col">
          {leadConnection || pendingConnection ? (
            <header className="flex items-center gap-2 px-1 pb-4 pt-2">
              {logo(24)}
              <span className="typography-ui-label font-semibold">OpenChamber</span>
            </header>
          ) : null}
          {body}
          {pendingConnection || !leadConnection ? null : addActions}
        </div>
      </main>
    </>
  );
};
