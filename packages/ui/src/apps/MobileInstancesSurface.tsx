import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { cn } from '@/lib/utils';

import { connectionDisplayUrl, isActiveRuntimeConnection, useMobileConnection } from './mobileConnections';
import { isQrScanSupported, scanConnectionQr } from './mobileQrScan';
import { mobileConnectionInputClass, mobileInputKeyboardProps } from './mobileConnectionUi';

export const MobileInstancesSurface: React.FC<{
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}> = ({ onActiveConnectionDeleted, onConnect }) => {
  const { t } = useI18n();
  const conn = useMobileConnection(onConnect);
  const {
    connections, isBusy, isPasswordBusy, error, pendingConnection,
    connect, submitPassword, cancelPassword, saveConnection, removeConnection, setError,
  } = conn;
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editingConnection = editingId ? connections.find((connection) => connection.id === editingId) ?? null : null;
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // The manual add/edit form is hidden until asked for — the sheet leads with
  // the list of instances (with live status), not a wall of inputs.
  const [formOpen, setFormOpen] = React.useState(false);
  // Which row is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);

  // Populate/clear the form imperatively (on edit tap / cancel / save) rather than via
  // an effect keyed on the derived connection object. With an effect, any churn of the
  // connections list re-fires it and overwrites what the user is typing — the keyboard
  // "resets" mid-edit. Imperative population is immune to that.
  const resetForm = React.useCallback(() => {
    setEditingId(null);
    setUrl('');
    setLabel('');
    setClientToken('');
    setError(null);
    setFormOpen(false);
  }, [setError]);

  const saveInstance = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    // The id is what makes this an EDIT: saveConnection uses it to preserve the
    // existing relay/https candidates (and the Keychain token they key) instead
    // of rebuilding the instance from the single URL field.
    void saveConnection({ id: editingId ?? undefined, url, label, clientToken }).then((saved) => {
      if (saved) resetForm();
    });
  }, [clientToken, editingId, label, resetForm, saveConnection, url]);

  // Scan a pairing QR into the add/edit form fields (does not change edit mode, so
  // the form-reset effect doesn't wipe the scanned values). The user reviews + saves.
  const handleScanInstance = React.useCallback(async () => {
    if (isScanning) return;
    setError(null);
    setIsScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          // Legacy token QR: prefill the manual form for review before saving.
          setUrl(result.url);
          if (result.label) setLabel(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          setFormOpen(true);
          break;
        case 'pairing':
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
      setIsScanning(false);
    }
  }, [conn, isScanning, setError, t]);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void submitPassword(password);
  }, [password, submitPassword]);

  const cancelPasswordPrompt = React.useCallback(() => {
    setPassword('');
    cancelPassword();
  }, [cancelPassword]);

  // Two-step delete (mirrors the session sheet): the trash icon arms the row, a
  // second tap on the destructive button confirms, the X disarms. No hover relied on.
  const toggleConfirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId((current) => (current === id ? null : id));
  }, []);

  const confirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId(null);
    if (editingId === id) resetForm();
    // Removing the ACTIVE instance — or the LAST one — must drop the user back
    // to the connect screen instead of leaving them in a stale, unbacked UI.
    const wasLast = connections.length === 1;
    void removeConnection(id).then((removed) => {
      if (!removed) return;
      if (wasLast || isActiveRuntimeConnection(removed)) {
        onActiveConnectionDeleted();
      }
    });
  }, [connections.length, editingId, onActiveConnectionDeleted, removeConnection, resetForm]);

  const inputClass = mobileConnectionInputClass;

  if (pendingConnection) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <form className="flex-1 overflow-y-auto px-5 py-4" onSubmit={handlePasswordSubmit}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : t('mobile.connect.relay.badge')}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className={inputClass}
            />
            {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={cancelPasswordPrompt}>
              {t('mobile.connect.cancelPassword')}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-6">
          {connections.length > 0 ? (
            <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
              {connections.map((connection) => {
                const confirming = confirmingDeleteId === connection.id;
                const isActive = isActiveRuntimeConnection(connection);
                const isConnectingRow = connectingId === connection.id;
                // Status line: the active instance says HOW it is connected right
                // now (direct vs relay); others show their address.
                const statusText = isConnectingRow
                  ? t('mobile.connect.connecting')
                  : isActive
                    ? (isRelayModeActive() ? t('mobile.instances.status.connectedRelay') : t('mobile.instances.status.connectedDirect'))
                    : connection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(connection) : t('mobile.connect.relay.badge');
                return (
                  <div
                    key={connection.id}
                    className={cn(
                      'flex items-center border-b border-border/70 transition-colors last:border-b-0',
                      confirming && 'bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)]',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-60"
                      onClick={() => {
                        if (isActive) return;
                        setConnectingId(connection.id);
                        void connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                          .finally(() => setConnectingId(null));
                      }}
                      disabled={(isBusy && !isConnectingRow) || confirming}
                    >
                      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                        <Icon name="server" className="size-[18px]" />
                        {isActive ? (
                          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-[var(--surface-elevated)] bg-[var(--status-success)]" aria-hidden />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                        <span className={cn(
                          'block truncate typography-small',
                          isActive && !isConnectingRow ? 'text-[var(--status-success)]' : 'text-muted-foreground',
                        )}>
                          {statusText}
                        </span>
                      </span>
                      {isConnectingRow ? <Icon name="loader-4" className="size-5 shrink-0 animate-spin text-muted-foreground" /> : null}
                    </button>
                    <div className="flex items-center gap-0.5 pr-2">
                      {confirming ? (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.confirmDeleteAria', { label: connection.label })}
                          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 text-destructive-foreground transition-opacity active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                          onClick={() => confirmDelete(connection.id)}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="delete-bin" className="size-[18px]" />
                          <span className="typography-ui-label">{t('mobile.instances.delete')}</span>
                        </button>
                      ) : !connection.candidates.some((c) => c.kind === 'direct') ? null : (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.edit')}
                          className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          onClick={() => {
                            setEditingId(connection.id);
                            setUrl(connectionDisplayUrl(connection));
                            setLabel(connection.label);
                            setClientToken(connection.clientToken || '');
                            setError(null);
                          }}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="edit" className="size-[18px]" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={confirming
                          ? t('mobile.instances.cancelDeleteAria', { label: connection.label })
                          : t('mobile.instances.deleteAria', { label: connection.label })}
                        className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onClick={() => toggleConfirmDelete(connection.id)}
                        style={{ touchAction: 'manipulation' }}
                      >
                        <Icon name={confirming ? 'close' : 'delete-bin'} className="size-[18px]" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-[18px] border border-dashed border-border/70 px-4 py-6 text-center typography-small text-muted-foreground">
              {t('mobile.connect.saved.empty')}
            </p>
          )}

          {/* Add actions: QR pairing is the primary path; the manual form stays
              hidden until asked for (or until a row's edit button opens it). */}
          {!formOpen && !editingConnection ? (
            <div className="space-y-2">
              {qrScanSupported ? (
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanInstance()}
                  disabled={isScanning}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {t('mobile.connect.scanQr')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant={qrScanSupported ? 'ghost' : 'outline'}
                size="lg"
                className="h-12 w-full"
                onClick={() => { setError(null); setFormOpen(true); }}
              >
                <Icon name="add" className="size-[18px]" />
                {t('mobile.instances.addManual')}
              </Button>
              {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            </div>
          ) : (
            <form className="space-y-3" onSubmit={saveInstance}>
              <div className="flex h-8 items-center justify-between gap-3 px-1">
                <h3 className="typography-ui-label text-foreground">
                  {editingConnection ? t('mobile.instances.editTitle') : t('mobile.instances.addTitle')}
                </h3>
                <Button type="button" variant="ghost" size="xs" onClick={resetForm}>
                  {t('mobile.instances.cancelEdit')}
                </Button>
              </div>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.url.label')}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={t('mobile.connect.url.placeholder')}
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.instances.label.label')}</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('mobile.instances.label.placeholder')}
                  autoComplete="off"
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.token.label')}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={clientToken}
                  onChange={(event) => setClientToken(event.target.value)}
                  placeholder={t('mobile.connect.token.placeholder')}
                  autoCapitalize="none"
                  className={inputClass}
                />
                <p className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
              </label>
              {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
              <Button type="submit" size="lg" className="mt-1 h-12 w-full">
                {editingConnection ? t('mobile.instances.saveEdit') : t('mobile.instances.saveNew')}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
