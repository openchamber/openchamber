import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SETTINGS_HELPER_CLASS, SettingsCheckboxRow, SettingsStackedField } from '../shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { GitManagedSshCandidate, GitManagedSshCredential, GitManagedSshIntent } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

type RejectionReason = 'candidate-expired' | 'candidate-changed' | 'fingerprint-mismatch' | 'candidate-unavailable' | 'inventory-full';
type InventoryState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  credentials: GitManagedSshCredential[];
  candidates: GitManagedSshCandidate[];
  truncated: boolean;
  discoveryAttempted: boolean;
  rejection?: RejectionReason;
  imported?: boolean;
};

type StatusTone = 'neutral' | 'error' | 'warning' | 'success';
const STATUS_TONE_CLASS = {
  neutral: '',
  error: 'text-[var(--status-error)]',
  warning: 'text-[var(--status-warning)]',
  success: 'text-[var(--status-success)]',
} satisfies Record<StatusTone, string>;

const initialState = (): InventoryState => ({
  status: 'idle', credentials: [], candidates: [], truncated: false, discoveryAttempted: false,
});

/** The managed SSH key picker inside the identity editor: inventory, discovery and import in one field. */
export function ManagedSshCredentials({ selection, disabled = false }: {
  selection: { value: string; onChange: (value: string) => void };
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const [state, setState] = React.useState<InventoryState>(initialState);
  const [hostSetup, setHostSetup] = React.useState(false);
  const [confirmedCandidateId, setConfirmedCandidateId] = React.useState('');
  const [passphrase, setPassphrase] = React.useState('');
  const generation = React.useRef(0);
  const onSelectionChange = selection?.onChange;
  React.useLayoutEffect(() => {
    const reset = () => {
      generation.current += 1;
      setState(initialState());
      setHostSetup(false);
      setConfirmedCandidateId('');
      setPassphrase('');
    };
    // Mounting keeps the identity's saved key; only a runtime switch makes it
    // name a key on another machine, so only that clears it.
    reset();
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => {
      reset();
      onSelectionChange?.('');
    });
    return () => { generation.current += 1; unsubscribe(); };
  }, [git, onSelectionChange]);

  const send = async (intent: GitManagedSshIntent) => {
    if (!git.managedSshCredentials || disabled || state.status === 'loading') return;
    const request = ++generation.current;
    const runtimeKey = getRuntimeKey();
    setState((current) => ({ ...current, status: 'loading', rejection: undefined, imported: false }));
    try {
      const result = await git.managedSshCredentials(intent);
      if (request !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (result.status === 'unsupported') {
        setHostSetup(true);
        setState(initialState());
        return;
      }
      setHostSetup(false);
      if (result.status === 'available') {
        if (selection?.value && !result.credentials.some((credential) => credential.credentialId === selection.value
          && credential.capability.status === 'ready')) selection.onChange('');
        setConfirmedCandidateId('');
        setState({ status: 'ready', credentials: result.credentials, candidates: [], truncated: false, discoveryAttempted: false });
        return;
      }
      if (result.status === 'discovered') {
        setConfirmedCandidateId('');
        setState((current) => ({ ...current, status: 'ready', candidates: result.candidates,
          truncated: result.truncated, discoveryAttempted: true }));
        return;
      }
      if (result.status === 'rejected') {
        setConfirmedCandidateId('');
        setState((current) => ({ ...current, status: 'ready', rejection: result.reason }));
        return;
      }
      setConfirmedCandidateId('');
      selection?.onChange(result.selectedCredential.credentialId);
      setPassphrase('');
      setState((current) => ({
        ...current,
        status: 'ready',
        credentials: result.credentials,
        candidates: [],
        truncated: false,
        discoveryAttempted: false,
        imported: true,
      }));
    } catch {
      if (request === generation.current && runtimeKey === getRuntimeKey()) {
        setState((current) => ({ ...current, status: 'error', imported: false }));
      }
    }
  };
  // The saved key is an opaque reference the field can only name once the
  // list is read, so it is read as the editor opens rather than on request.
  const sendRef = React.useRef(send);
  sendRef.current = send;
  React.useEffect(() => {
    void sendRef.current({ operation: 'inventory' });
  }, [git]);
  const credentialReason = (credential: GitManagedSshCredential) => {
    if (credential.capability.status === 'ready') return '';
    if (credential.capability.reason === 'unreadable') return t('settings.sourceControl.ssh.unreadable');
    if (credential.capability.reason === 'fingerprint-mismatch') return t('settings.sourceControl.ssh.changed');
    return t('settings.sourceControl.ssh.unverifiable');
  };
  const candidateReason = (candidate: GitManagedSshCandidate) => {
    if (candidate.capability.status === 'ready') return '';
    if (candidate.capability.reason === 'unreadable') return t('settings.sourceControl.ssh.unreadable');
    if (candidate.capability.reason === 'insecure-permissions') return t('settings.sourceControl.ssh.insecurePermissions');
    return t('settings.sourceControl.ssh.unverifiable');
  };
  const rejectionMessage = () => {
    if (!state.rejection) return '';
    if (state.rejection === 'candidate-expired') return t('settings.sourceControl.ssh.candidateExpired');
    if (state.rejection === 'candidate-changed') return t('settings.sourceControl.ssh.candidateChanged');
    if (state.rejection === 'fingerprint-mismatch') return t('settings.sourceControl.ssh.confirmationMismatch');
    if (state.rejection === 'inventory-full') return t('settings.sourceControl.ssh.inventoryFull');
    return t('settings.sourceControl.ssh.candidateUnavailable');
  };
  const describeCredential = (credential: GitManagedSshCredential) =>
    [credential.label, credential.fingerprint, credentialReason(credential)].filter(Boolean).join(' · ');
  const selectedCredential = state.credentials.find((credential) => credential.credentialId === selection.value) ?? null;
  const rejection = rejectionMessage();
  const controlsDisabled = disabled || state.status === 'loading' || !git.managedSshCredentials;
  // Most important first: what failed, what is in progress, what blocks the
  // feature, then outcomes and empty states.
  const status = (text: string, tone: StatusTone) => ({ text, tone });
  const statusLine = rejection
    ? status(rejection, 'error')
    : state.status === 'error' ? status(t('settings.sourceControl.ssh.operationFailed'), 'error')
    : state.status === 'loading' ? status(t('settings.sourceControl.transport.loading'), 'neutral')
    : hostSetup || !git.managedSshCredentials ? status(t('settings.sourceControl.ssh.hostSetup'), 'neutral')
    : state.truncated ? status(t('settings.sourceControl.ssh.discoveryTruncated'), 'warning')
    : state.imported ? status(t('settings.sourceControl.ssh.imported'), 'success')
    : state.status === 'ready' && state.discoveryAttempted && !state.candidates.length ? status(t('settings.sourceControl.ssh.discoveredEmpty'), 'neutral')
    : state.status === 'ready' && !state.credentials.length ? status(t('settings.sourceControl.ssh.empty'), 'neutral')
    : null;

  // The editor draws the field's label; this is the control column of its row.
  return <div className="flex min-w-0 flex-1 flex-col gap-2">
    <SettingsStackedField label={t('settings.sourceControl.ssh.passphrase')}
      info={t('settings.sourceControl.ssh.passphraseHint')}>
      <Input type="password" value={passphrase} autoComplete="off" maxLength={1024} className="h-8 rounded-md px-3"
        aria-label={t('settings.sourceControl.ssh.passphrase')} disabled={controlsDisabled}
        onChange={(event) => {
          setPassphrase(event.target.value);
          setConfirmedCandidateId('');
          setState((current) => ({ ...current, candidates: [], discoveryAttempted: false }));
        }} />
    </SettingsStackedField>
    {/* Keep actions on the same line as the disabled stand-in. Long selected
        fingerprints truncate within the remaining width instead of wrapping actions. */}
    <div className="flex min-w-0 items-center gap-2">
      <Select value={selection.value} onValueChange={selection.onChange} disabled={disabled || state.status !== 'ready'}>
        <SelectTrigger className="min-w-0 max-w-full" aria-label={t('settings.sourceControl.ssh.title')}>
          <SelectValue placeholder={t('settings.sourceControl.ssh.title')}>
            {/* The value is an opaque reference; only the safe label may be shown. */}
            {selectedCredential ? describeCredential(selectedCredential) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>{state.credentials.map((credential) => <SelectItem key={credential.credentialId} value={credential.credentialId} disabled={credential.capability.status !== 'ready'}>
          {describeCredential(credential)}
        </SelectItem>)}</SelectContent>
      </Select>
      {/* The list loads as the editor opens; this only brings it back after
          a failed read or a runtime switch. */}
      {state.status === 'idle' || state.status === 'error' ? (
        <Button size="sm" variant="outline" className="shrink-0" disabled={controlsDisabled} onClick={() => void send({ operation: 'inventory' })}>
          {t('settings.sourceControl.ssh.load')}
        </Button>
      ) : null}
      <Button size="sm" variant="outline" className="shrink-0" disabled={controlsDisabled} onClick={() => void send({ operation: 'discover', passphrase: passphrase || undefined })}>
        {t('settings.sourceControl.ssh.discover')}
      </Button>
    </div>
    {state.candidates.length ? <div className="space-y-4">
      {state.candidates.map((candidate, index) => 'candidateId' in candidate ? <div key={candidate.candidateId} className="space-y-2 border-t border-edge pt-3">
        <p className="typography-settings-field-label text-foreground">{candidate.label}</p>
        <p className={cn(SETTINGS_HELPER_CLASS, 'break-all')}>{candidate.fingerprint}</p>
        <SettingsCheckboxRow
          checked={confirmedCandidateId === candidate.candidateId}
          onChange={(checked) => setConfirmedCandidateId(checked ? candidate.candidateId : '')}
          disabled={disabled || state.status === 'loading'}
          className="min-w-0 break-all"
          label={t('settings.sourceControl.ssh.confirmFingerprint', { fingerprint: candidate.fingerprint })}
          ariaLabel={t('settings.sourceControl.ssh.confirmFingerprint', { fingerprint: candidate.fingerprint })}
        />
        <Button size="sm" variant="default" disabled={disabled || state.status === 'loading' || confirmedCandidateId !== candidate.candidateId}
          onClick={() => void send({ operation: 'import', candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint, confirmed: true,
            passphrase: passphrase || undefined })}>
          {t('settings.sourceControl.ssh.import')}
        </Button>
      </div> : <p key={`${candidate.label}-${index}`} className={SETTINGS_HELPER_CLASS}>
        {[candidate.label, candidateReason(candidate)].filter(Boolean).join(' · ')}
      </p>)}
    </div> : null}
    {/* One status line, always in place: switching auth method or loading
        the list must not grow the dialog, so the slot keeps its line even
        when empty and shows only the most important message. */}
    <p
      role={statusLine?.tone === 'error' ? 'alert' : 'status'}
      title={statusLine?.text}
      className={cn(SETTINGS_HELPER_CLASS, 'min-h-[1lh] truncate', statusLine && STATUS_TONE_CLASS[statusLine.tone])}
    >
      {statusLine?.text}
    </p>
  </div>;
}
