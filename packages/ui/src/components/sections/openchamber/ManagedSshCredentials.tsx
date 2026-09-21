import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SETTINGS_HELPER_CLASS, SETTINGS_SELECT_SIZE, SettingsCheckboxRow, SettingsStackedField } from '../shared/SettingsSection';
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
  const generation = React.useRef(0);
  const onSelectionChange = selection?.onChange;
  React.useLayoutEffect(() => {
    const reset = () => {
      generation.current += 1;
      setState(initialState());
      setHostSetup(false);
      setConfirmedCandidateId('');
      onSelectionChange?.('');
    };
    reset();
    const unsubscribe = subscribeRuntimeEndpointWillChange(reset);
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
      const importedCandidateId = intent.operation === 'import' ? intent.candidateId : '';
      setState((current) => ({
        ...current,
        status: 'ready',
        credentials: result.credentials,
        candidates: current.candidates.filter((candidate) => !('candidateId' in candidate)
          || candidate.candidateId !== importedCandidateId),
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

  const content = <>

    <Select value={selection.value} onValueChange={selection.onChange} disabled={disabled || state.status !== 'ready'}>
      <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full" aria-label={t('settings.sourceControl.ssh.title')}>
        <SelectValue placeholder={t('settings.sourceControl.ssh.title')}>
          {/* The value is an opaque reference; only the safe label may be shown. */}
          {selectedCredential ? describeCredential(selectedCredential) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>{state.credentials.map((credential) => <SelectItem key={credential.credentialId} value={credential.credentialId} disabled={credential.capability.status !== 'ready'}>
        {describeCredential(credential)}
      </SelectItem>)}</SelectContent>
    </Select>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => void send({ operation: 'inventory' })}>
        {t('settings.sourceControl.ssh.load')}
      </Button>
      <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => void send({ operation: 'discover' })}>
        {t('settings.sourceControl.ssh.discover')}
      </Button>
    </div>
    {state.candidates.length ? <div className="space-y-4">
      {state.candidates.map((candidate, index) => 'candidateId' in candidate ? <div key={candidate.candidateId} className="space-y-2 border-t border-border/60 pt-3">
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
          onClick={() => void send({ operation: 'import', candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint, confirmed: true })}>
          {t('settings.sourceControl.ssh.import')}
        </Button>
      </div> : <p key={`${candidate.label}-${index}`} className={SETTINGS_HELPER_CLASS}>
        {[candidate.label, candidateReason(candidate)].filter(Boolean).join(' · ')}
      </p>)}
    </div> : null}
    {state.status === 'loading' ? <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.sourceControl.transport.loading')}</p> : null}
    {state.status === 'error' ? <p role="alert" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-error)]')}>{t('settings.sourceControl.ssh.operationFailed')}</p> : null}
    {rejection ? <p role="alert" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-error)]')}>{rejection}</p> : null}
    {state.imported ? <p role="status" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-success)]')}>{t('settings.sourceControl.ssh.imported')}</p> : null}
    {state.status === 'ready' && !state.credentials.length ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.sourceControl.ssh.empty')}</p> : null}
    {state.status === 'ready' && state.discoveryAttempted && !state.candidates.length ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.sourceControl.ssh.discoveredEmpty')}</p> : null}
    {state.truncated ? <p role="status" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-warning)]')}>{t('settings.sourceControl.ssh.discoveryTruncated')}</p> : null}
    {hostSetup || !git.managedSshCredentials ? <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.sourceControl.ssh.hostSetup')}</p> : null}
  </>;

  return <SettingsStackedField className="min-w-0 w-full" controlClassName="max-w-none flex-col items-stretch gap-3"
    label={t('settings.sourceControl.ssh.title')} info={t('settings.sourceControl.ssh.hostSetup')}>
    {content}
  </SettingsStackedField>;
}
