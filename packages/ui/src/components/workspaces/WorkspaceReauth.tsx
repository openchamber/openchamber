import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { WorkspacePrivilegedOperation, WorkspaceReauthProofResult } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

type PendingReauth = {
  operation: WorkspacePrivilegedOperation;
  project: string;
  payload: Record<string, unknown>;
  resolve: (proof: WorkspaceReauthProofResult | null) => void;
};

type WorkspaceReauthOptions = {
  /** Return true to resolve null without any prompt (e.g. the capability is already known-missing). */
  shouldSkip?: (operation: WorkspacePrivilegedOperation) => boolean;
  /** Return true when the error was absorbed (e.g. recorded as a missing capability). */
  onError?: (error: unknown) => boolean;
};

export type WorkspaceReauth = {
  /**
   * Obtain a one-time privileged proof. Tries a still-valid step-up window, then a
   * passkey, and only then opens the password dialog — one ceremony unlocks the
   * adjacent privileged actions for the duration of the server-side window.
   */
  requestProof: (operation: WorkspacePrivilegedOperation, project: string, payload: Record<string, unknown>) => Promise<WorkspaceReauthProofResult | null>;
  /** End of the active step-up window, when known. */
  windowExpiresAt: number | null;
  /** Render once per surface. */
  dialog: React.ReactNode;
};

const isSetupRequired = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { setupRequired?: boolean }).setupRequired === true);

const OPERATION_LABEL_KEYS = {
  'workspace.create': 'settings.workspaces.reauth.op.workspaceCreate',
  'workspace.session.start': 'settings.workspaces.reauth.op.sessionStart',
  'workspace.cleanup': 'settings.workspaces.reauth.op.cleanup',
  'workspace.configure': 'settings.workspaces.reauth.op.configure',
  'workspace.validate': 'settings.workspaces.reauth.op.validate',
  'workspace.setup': 'settings.workspaces.reauth.op.setup',
  'workspace.reconcile': 'settings.workspaces.reauth.op.reconcile',
  'workspace.export': 'settings.workspaces.reauth.op.export',
  'host.apply': 'settings.workspaces.reauth.op.hostApply',
  'host.capabilities': 'settings.workspaces.reauth.op.hostCapabilities',
} as const;

export function useWorkspaceReauth(options?: WorkspaceReauthOptions): WorkspaceReauth {
  const { t } = useI18n();
  const runtimeAPIs = useRuntimeAPIs();
  const [pending, setPending] = React.useState<PendingReauth | null>(null);
  const [setupRequired, setSetupRequired] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [windowExpiresAt, setWindowExpiresAt] = React.useState<number | null>(null);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const noteWindow = React.useCallback((proof: WorkspaceReauthProofResult | null) => {
    if (proof && typeof proof.windowExpiresAt === 'number') setWindowExpiresAt(proof.windowExpiresAt);
    return proof;
  }, []);

  const requestProof = React.useCallback(async (operation: WorkspacePrivilegedOperation, project: string, payload: Record<string, unknown>) => {
    if (!runtimeAPIs.workspaces) return null;
    if (optionsRef.current?.shouldSkip?.(operation)) return null;
    try {
      return noteWindow(await runtimeAPIs.workspaces.reauthenticate({ operation, project, payload }));
    } catch (silentError) {
      if (optionsRef.current?.onError?.(silentError)) return null;
      return new Promise<WorkspaceReauthProofResult | null>((resolve) => {
        setPassword('');
        setError('');
        setSetupRequired(isSetupRequired(silentError));
        setPending({ operation, project, payload, resolve });
      });
    }
  }, [noteWindow, runtimeAPIs.workspaces]);

  const close = React.useCallback((proof: WorkspaceReauthProofResult | null) => {
    setPending((current) => {
      current?.resolve(proof);
      return null;
    });
    setPassword('');
    setError('');
    setSetupRequired(false);
  }, []);

  /** Takes the operator to the page that holds the credential this action needs. */
  const openCredentialSettings = React.useCallback(() => {
    setPending(null);
    setSetupRequired(false);
    useUIStore.getState().setSettingsPage('general');
    useUIStore.getState().setSettingsDialogOpen(true);
  }, []);

  const cancel = React.useCallback(() => {
    if (busy) return;
    close(null);
  }, [busy, close]);

  const confirm = React.useCallback(async () => {
    if (!pending || !runtimeAPIs.workspaces || busy) return;
    setBusy(true);
    setError('');
    try {
      const proof = noteWindow(await runtimeAPIs.workspaces.reauthenticate({
        operation: pending.operation,
        project: pending.project,
        payload: pending.payload,
        password: password || undefined,
      }));
      close(proof);
    } catch (confirmError) {
      if (optionsRef.current?.onError?.(confirmError)) {
        close(null);
      } else if (isSetupRequired(confirmError)) {
        setSetupRequired(true);
      } else {
        setError(confirmError instanceof Error ? confirmError.message : t('settings.workspaces.reauth.failed'));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, close, noteWindow, password, pending, runtimeAPIs.workspaces, t]);

  const dialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.workspaces.reauth.title')}</DialogTitle>
          <DialogDescription>
            {setupRequired ? t('settings.workspaces.reauth.setupRequired') : t('settings.workspaces.reauth.prompt')}
          </DialogDescription>
        </DialogHeader>
        {pending && !setupRequired ? (
          <p className="typography-ui font-medium text-foreground">{t(OPERATION_LABEL_KEYS[pending.operation])}</p>
        ) : null}
        {setupRequired ? null : (
          <>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void confirm(); }}
              placeholder={t('sessionAuth.password.placeholder')}
              aria-label={t('sessionAuth.password.placeholder')}
              disabled={busy}
              autoFocus
            />
            <p className="typography-meta text-muted-foreground">{t('settings.workspaces.reauth.windowHint')}</p>
          </>
        )}
        {error ? <p className="typography-meta text-[var(--status-error)]" role="alert">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={cancel} disabled={busy}>{t('settings.common.actions.cancel')}</Button>
          {setupRequired ? (
            <Button size="sm" onClick={openCredentialSettings}>{t('settings.workspaces.reauth.openPasswordSettings')}</Button>
          ) : (
            <Button size="sm" onClick={() => void confirm()} disabled={busy}>{t('settings.workspaces.reauth.confirm')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { requestProof, windowExpiresAt, dialog };
}
