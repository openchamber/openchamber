import React from 'react';
import {
  identityAccountConnected,
  identityDisplayName,
  instanceHost,
  remoteTraits,
  selectableIdentities,
  type RemoteTraits,
} from '@/lib/source-control/identity';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type {
  GitAuxiliaryBindingIntent,
  GitCheckoutHydrationRequirement,
  GitIdentityProfile,
  GitNetworkOperation,
} from '@/lib/api/types';
import { identityTransport, isCompleteIdentity } from '@/lib/api/git-identity';
import {
  auxiliaryGrantIntent,
  describeIdentityApplicability,
  grantIdentityToRemote,
  identityApplicability,
  needsSystemAcknowledgement,
  type IdentityApplicability,
} from '@/lib/source-control/applyIdentity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { GitOperationResultError, runCheckoutHydration } from '@/lib/boundGitNetworkOperation';
import { repositoryBindingOwner, useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useConnectedAccountIds, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useGitIdentity } from '@/stores/useGitStore';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsGroupTitle,
  SettingsStackedField,
} from '../shared/SettingsSection';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { IdentityDropdown } from '@/components/views/git/GitHeader';
import { useGitOperationRecovery } from '@/components/views/git/useGitOperationRecovery';
import { GitOperationStatus } from '@/components/views/git/GitOperationStatus';

type SourceControlBindingSettingsProps = {
  className?: string;
  directory: string;
};

/** Selects inside the binding editors fill their stacked field instead of the shared settings width cap. */
const EDITOR_CONTROL_CLASS = 'max-w-none';
/** Action row under each editor: primary save first, quiet removal second. */
const EDITOR_ACTIONS_CLASS = 'flex flex-wrap items-center gap-2';

const EditorStatus = ({ error, children }: { error?: boolean; children: React.ReactNode }) => (
  <p role={error ? 'alert' : undefined} className={cn(SETTINGS_HELPER_CLASS, error && 'text-[var(--status-error)]')}>
    {children}
  </p>
);

const hydrationRequirements = (operation: GitNetworkOperation | undefined): GitCheckoutHydrationRequirement[] => {
  if (!operation || operation.target.operation !== 'checkout-hydration') return [];
  const entries = [...operation.target.requirements];
  const discovered = [
    ...(operation.hydration?.submodules ?? []).map((item) => ({ kind: 'submodule' as const, item })),
    ...(operation.hydration?.lfs ?? []).map((item) => ({ kind: 'lfs' as const, item })),
  ];
  for (const { kind, item } of discovered) {
    const endpoint = item.endpoint;
    if (!endpoint) continue;
    if (!entries.some((entry) => entry.kind === kind && entry.path === item.path
      && entry.endpoint.fingerprint === endpoint.fingerprint)) {
      entries.push({ kind, path: item.path, endpoint });
    }
  }
  return entries;
};

/**
 * The remotes the repository's identity has not been given yet.
 *
 * An identity is written for the remote it was applied to, and a grant names
 * one exact endpoint. A repository that carries a second address — a fork
 * beside its upstream — therefore has one address OpenChamber will not use,
 * and no way to say otherwise. This is that way: the remotes are listed with
 * what stands in their way, and the one the identity can serve gets a button.
 */
export const AdditionalRemoteGrants: React.FC<SourceControlBindingSettingsProps> = ({ directory, className }) => {
  const { t } = useI18n();
  const { git, sourceControl } = useRuntimeAPIs();
  const binding = useRepositoryBinding(directory, sourceControl);
  const gitIdentityProfiles = useGitIdentitiesStore((state) => state.profiles);
  const globalGitIdentity = useGitIdentitiesStore((state) => state.globalIdentity);
  const connectedAccountIds = useConnectedAccountIds();
  const repositoryAuthor = useGitIdentity(directory);
  const [pending, setPending] = React.useState('');
  const [unverifiedConfirmed, setUnverifiedConfirmed] = React.useState(false);
  const [error, setError] = React.useState(false);
  const requestRef = React.useRef(0);

  React.useLayoutEffect(() => {
    requestRef.current += 1;
    setPending('');
    setUnverifiedConfirmed(false);
    setError(false);
    return () => { requestRef.current += 1; };
  }, [binding.scope, git, sourceControl]);

  const read = binding.read;
  const identities = React.useMemo(
    () => selectableIdentities(gitIdentityProfiles, globalGitIdentity,
      (profile) => isCompleteIdentity(profile) && identityAccountConnected(profile, connectedAccountIds)),
    [connectedAccountIds, gitIdentityProfiles, globalGitIdentity],
  );
  // The repository acts as the identity its author names; that is the one
  // whose reach these remotes are measured against.
  const identity = identities.find((profile) => profile.userName === repositoryAuthor?.userName
    && profile.userEmail === repositoryAuthor?.userEmail) ?? null;
  // A grant whose address moved under it, or whose account is in question, is
  // as unusable as none at all, and applying the identity again cannot rewrite
  // it — the authority it was written against is gone. So it is offered here
  // beside the addresses that never had one.
  // The address the identity was applied to is the repository's own, and the
  // strip beside it already says when that one needs attention.
  const primaryRemote = read?.binding?.providers[0]?.primaryRemote
    ?? read?.binding?.remotes[0]?.name ?? 'origin';
  const ungranted = (read?.repository.remotes ?? []).filter((remote) => remote.name !== primaryRemote
    && read?.binding?.remotes.find((grant) => grant.name === remote.name)?.readiness !== 'ready');

  const grant = async (remoteName: string) => {
    if (!identity || pending) return;
    const request = requestRef.current;
    const runtimeKey = getRuntimeKey();
    const isCurrent = () => requestRef.current === request && runtimeKey === getRuntimeKey();
    setPending(remoteName);
    setError(false);
    const outcome = await grantIdentityToRemote(
      { directory, identity, remoteName, acknowledgedSystem: unverifiedConfirmed },
      { git, sourceControl },
    );
    if (!isCurrent()) return;
    if (outcome.status !== 'applied') setError(true);
    setPending('');
  };

  // Nothing to say when the repository has no other remote, or when its
  // identity carries no credentials to give one.
  if (!identity || !ungranted.length || !git.configureTransportBinding) return null;
  const needsConfirmation = needsSystemAcknowledgement(identity, true);

  return (
    <SettingsControlGroup
      title={t('gitView.remotes.title')}
      description={t('gitView.remotes.description')}
      className={cn('min-w-0', className)}
      contentClassName={SETTINGS_FIELDS_STACK_CLASS}
    >
      {ungranted.map((remote) => {
        const fit = identityApplicability(identity, remoteTraits(remote.fetch.displayUrl));
        return (
          <div key={remote.name} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="typography-ui-label text-foreground">{remote.name}</p>
              <p className={cn(SETTINGS_HELPER_CLASS, 'break-all')}>
                {fit.applicable
                  ? remote.fetch.displayUrl
                  : describeIdentityApplicability(fit, t)}
              </p>
            </div>
            {fit.applicable ? (
              <Button size="sm" variant="outline"
                disabled={Boolean(pending) || (needsConfirmation && !unverifiedConfirmed)}
                onClick={() => void grant(remote.name)}>
                {t('gitView.remotes.grant', { identity: identityDisplayName(identity, t) })}
              </Button>
            ) : null}
          </div>
        );
      })}
      {needsConfirmation ? <SettingsCheckboxRow checked={unverifiedConfirmed} onChange={setUnverifiedConfirmed}
        disabled={Boolean(pending)} label={t('settings.sourceControl.transport.unverifiedConfirmation')} /> : null}
      {error ? <EditorStatus error>{t('settings.gitlab.status.operationFailed')}</EditorStatus> : null}
    </SettingsControlGroup>
  );
};

export const AuxiliaryBindingSettings: React.FC<SourceControlBindingSettingsProps> = ({ directory, className }) => {
  const { t } = useI18n();
  const { git, sourceControl } = useRuntimeAPIs();
  const binding = useRepositoryBinding(directory, sourceControl);
  const recovery = useGitOperationRecovery(directory, git, sourceControl);
  const [parentRemote, setParentRemote] = React.useState('');
  const [selectedRequirement, setSelectedRequirement] = React.useState('');
  const [identityChoice, setIdentityChoice] = React.useState<{ endpoint: string; id: string } | null>(null);
  const [unverifiedConfirmed, setUnverifiedConfirmed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const requestRef = React.useRef(0);
  const gitIdentityProfiles = useGitIdentitiesStore((state) => state.profiles);
  const globalGitIdentity = useGitIdentitiesStore((state) => state.globalIdentity);
  const loadGitIdentityProfiles = useGitIdentitiesStore((state) => state.loadProfiles);
  const loadGlobalGitIdentity = useGitIdentitiesStore((state) => state.loadGlobalIdentity);
  const connectedAccountIds = useConnectedAccountIds();
  const refreshIdentityAccounts = useSourceControlAuthStore((state) => state.refreshIdentityAccounts);
  const repositoryAuthor = useGitIdentity(directory);
  const latest = recovery.entry?.reads.at(-1)?.operation;
  const requirements = latest?.target.operation === 'checkout-hydration'
    && latest.target.remote.name === parentRemote ? hydrationRequirements(latest) : [];
  const selected = requirements.find((entry) => JSON.stringify([entry.kind, entry.path, entry.endpoint.fingerprint]) === selectedRequirement);
  const read = binding.read;
  const remote = read?.repository.remotes.find((entry) => entry.name === parentRemote);
  const currentGrant = selected && read?.binding?.auxiliary.find((entry) => entry.kind === selected.kind
    && entry.endpoint.fingerprint === selected.endpoint.fingerprint);

  React.useLayoutEffect(() => {
    requestRef.current += 1;
    setParentRemote('');
    setSelectedRequirement('');
    setIdentityChoice(null);
    setUnverifiedConfirmed(false);
    setSaving(false);
    setError(false);
    setOpen(false);
    return () => { requestRef.current += 1; };
  }, [binding.scope, git, sourceControl]);

  React.useLayoutEffect(() => {
    setUnverifiedConfirmed(false);
  }, [selected?.endpoint.fingerprint]);

  React.useEffect(() => {
    if (!open) return;
    void loadGitIdentityProfiles();
    void loadGlobalGitIdentity();
  }, [loadGitIdentityProfiles, loadGlobalGitIdentity, open]);

  // A submodule or LFS server is authenticated the same way a remote is, so it
  // is answered with an identity rather than with a transport and a credential
  // chosen apart from it. Identities kept from an earlier release name no
  // account and no transport, so they have nothing to grant an endpoint with
  // and are not offered here.
  const availableIdentities = React.useMemo(
    () => selectableIdentities(gitIdentityProfiles, globalGitIdentity,
      (identity) => isCompleteIdentity(identity) && identityAccountConnected(identity, connectedAccountIds)),
    [connectedAccountIds, gitIdentityProfiles, globalGitIdentity],
  );
  const endpointUrl = selected?.endpoint.displayUrl ?? '';
  const endpoint = React.useMemo((): RemoteTraits | null => endpointUrl ? remoteTraits(endpointUrl) : null, [endpointUrl]);
  const applicabilityOf = React.useCallback((identity: GitIdentityProfile): IdentityApplicability =>
    endpoint ? identityApplicability(identity, endpoint) : { applicable: true }, [endpoint]);

  /**
   * The identity this endpoint is proposed with.
   *
   * A submodule on the repository's own host is the ordinary case, and the
   * repository already answered who it acts as there, so that identity is
   * offered and only has to be confirmed. An endpoint on another host is a
   * question OpenChamber cannot answer — no identity on file speaks for it —
   * so nothing is proposed and the person names one.
   */
  const proposedIdentity = React.useMemo(() => {
    const applicable = availableIdentities.filter((identity) => applicabilityOf(identity).applicable);
    const signedAs = repositoryAuthor?.userName && repositoryAuthor.userEmail
      ? applicable.find((identity) => identity.userName === repositoryAuthor.userName
        && identity.userEmail === repositoryAuthor.userEmail)
      : undefined;
    return signedAs
      ?? applicable.find((identity) => identity.account && endpoint?.host
        && instanceHost(identity.account.instance) === endpoint.host)
      ?? null;
  }, [applicabilityOf, availableIdentities, endpoint, repositoryAuthor]);
  const identity = (identityChoice?.endpoint === selected?.endpoint.fingerprint
    ? availableIdentities.find((entry) => entry.id === identityChoice?.id)
    : null) ?? proposedIdentity;
  const transport = identity ? identityTransport(identity) : null;
  const canSave = Boolean(binding.status === 'ready' && read?.binding && remote && selected
    && git.configureAuxiliaryBinding && !saving && identity && applicabilityOf(identity).applicable
    && (transport !== 'system' || unverifiedConfirmed)
    && (transport !== 'account' || identity?.account)
    && (transport !== 'ssh' || identity?.sshCredentialId));
  const canRemove = Boolean(binding.status === 'ready' && currentGrant && remote && git.configureAuxiliaryBinding && !saving);

  const retryHydration = async () => {
    if (!parentRemote || recovery.blocked) return;
    const action = recovery.start();
    if (!action) return;
    setError(false);
    try {
      await runCheckoutHydration({
        directory, git, sourceControl, parentRemoteName: parentRemote, onOperation: action.onOperation,
      });
    } catch (caught) {
      if (!(caught instanceof GitOperationResultError)) setError(true);
    } finally {
      action.finish();
    }
  };

  const save = async (operation: 'configure' | 'remove') => {
    if ((operation === 'configure' && !canSave) || (operation === 'remove' && !canRemove)
      || !binding.isCurrent() || !read?.binding || !remote || !selected || !git.configureAuxiliaryBinding) return;
    const request = requestRef.current;
    const runtimeKey = getRuntimeKey();
    const isCurrent = () => requestRef.current === request && runtimeKey === getRuntimeKey();
    const authority = {
      directory,
      expectedRepositoryId: read.repository.repositoryId,
      expectedRevision: read.revision,
      expectedConfigRevision: read.repository.configRevision,
      parentRemote,
      expectedParentFingerprint: remote.fetch.fingerprint,
      kind: selected.kind,
      path: selected.path,
      expectedEndpointFingerprint: selected.endpoint.fingerprint,
    };
    const intent: GitAuxiliaryBindingIntent | null = operation === 'remove'
      ? { ...authority, operation }
      : identity && auxiliaryGrantIntent(identity, authority, unverifiedConfirmed);
    if (!intent) return;
    const mutationScope = repositoryBindingOwner.captureMutation(binding.scope, read);
    setSaving(true);
    setError(false);
    try {
      const result = await git.configureAuxiliaryBinding(intent);
      if (!repositoryBindingOwner.setMutationResult(mutationScope, result.binding)) {
        await repositoryBindingOwner.reconcile(mutationScope, sourceControl);
      }
      if (isCurrent()) setUnverifiedConfirmed(false);
    } catch {
      if (isCurrent()) setError(true);
      await repositoryBindingOwner.reconcile(mutationScope, sourceControl);
    } finally {
      mutationScope.release();
      if (isCurrent()) setSaving(false);
    }
  };

  // The operation card carries the server's own code and message, which names
  // the mechanism rather than the next step. Beside the endpoints it stopped
  // on, this says what to do about them.
  const authorizationNeeded = Boolean(requirements.length && latest && 'error' in latest
    && latest.error.code === 'AUTHENTICATION_REQUIRED');

  const kindLabel = (kind: GitCheckoutHydrationRequirement['kind']) => t(kind === 'submodule' ? 'gitView.hydration.kind.submodule' : 'gitView.hydration.kind.lfs');

  // Most repositories have neither submodules nor LFS, and the endpoint list
  // only appears once a parent remote is chosen and the checkout is inspected.
  // The block therefore stays closed until someone asks for it.
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('min-w-0', className)}>
      <CollapsibleTrigger className="w-auto justify-start gap-1.5">
        <SettingsGroupTitle>{t('gitView.hydration.title')}</SettingsGroupTitle>
        <Icon name={open ? 'arrow-up-s' : 'arrow-down-s'} className="h-4 w-4 text-muted-foreground" />
      </CollapsibleTrigger>
      <CollapsibleContent>
    <SettingsControlGroup
      description={t('gitView.hydration.description')}
      className="min-w-0 pt-2"
      contentClassName={SETTINGS_FIELDS_STACK_CLASS}
    >
      <SettingsStackedField label={t('gitView.hydration.parentRemote')} controlClassName={EDITOR_CONTROL_CLASS}>
        <Select value={parentRemote} onValueChange={(value) => {
          setParentRemote(value);
          setSelectedRequirement('');
          setIdentityChoice(null);
          setUnverifiedConfirmed(false);
        }} disabled={!read?.binding || saving || recovery.blocked}>
          <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full" aria-label={t('gitView.hydration.parentRemote')}>
            <SelectValue placeholder={t('settings.sourceControl.transport.remoteLabel')} />
          </SelectTrigger>
          <SelectContent>{read?.binding?.remotes.filter((entry) => entry.readiness === 'ready').map((entry) => (
            <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>
          ))}</SelectContent>
        </Select>
      </SettingsStackedField>
      <GitOperationStatus entry={recovery.entry} onRefresh={() => void recovery.refresh()} onCancel={() => void recovery.cancel()} />
      {authorizationNeeded ? <p className={SETTINGS_HELPER_CLASS}>{t('gitView.hydration.authorizationNeeded')}</p> : null}
      {requirements.length ? <SettingsStackedField label={t('gitView.hydration.endpoint')} controlClassName={EDITOR_CONTROL_CLASS}>
        <Select value={selectedRequirement} onValueChange={setSelectedRequirement} disabled={saving}>
          <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full" aria-label={t('gitView.hydration.endpoint')}>
            <SelectValue placeholder={t('gitView.hydration.chooseEndpoint')}>
              {selected ? `${selected.path} · ${kindLabel(selected.kind)} · ${selected.endpoint.displayUrl}` : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>{requirements.map((entry) => {
            const key = JSON.stringify([entry.kind, entry.path, entry.endpoint.fingerprint]);
            return <SelectItem key={key} value={key}>{entry.path} · {kindLabel(entry.kind)} · {entry.endpoint.displayUrl}</SelectItem>;
          })}</SelectContent>
        </Select>
      </SettingsStackedField> : null}
      {selected ? <>
        <SettingsStackedField label={t('gitView.hydration.identity')} controlClassName={EDITOR_CONTROL_CLASS}>
          <IdentityDropdown
            activeProfile={identity}
            identities={availableIdentities}
            onSelect={(profile) => {
              setIdentityChoice({ endpoint: selected.endpoint.fingerprint, id: profile.id });
              setUnverifiedConfirmed(false);
            }}
            isApplying={saving}
            applicability={applicabilityOf}
            triggerClassName="w-full max-w-none border border-border"
            menuAlign="start"
            onOpen={() => void refreshIdentityAccounts(sourceControl, gitIdentityProfiles.map((profile) => profile.account))}
          />
        </SettingsStackedField>
        {transport === 'system' ? <SettingsCheckboxRow checked={unverifiedConfirmed} onChange={setUnverifiedConfirmed} disabled={saving}
          label={t('gitView.hydration.systemConfirmation')} /> : null}
      </> : null}
      {latest?.hydration?.status === 'client-missing' ? <p role="alert" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-warning)]')}>
        {t('gitView.hydration.lfsMissing')}
      </p> : null}
      {error ? <EditorStatus error>{t('settings.gitlab.status.operationFailed')}</EditorStatus> : null}
      <div className={EDITOR_ACTIONS_CLASS}>
        <Button size="sm" variant="outline" disabled={!parentRemote || recovery.blocked || saving} onClick={() => void retryHydration()}>
          {t('gitView.hydration.retry')}
        </Button>
        {selected ? <>
          <Button size="sm" disabled={!canSave} onClick={() => void save('configure')}>{t('settings.common.actions.saveChanges')}</Button>
          {currentGrant ? <Button size="sm" variant="ghost" disabled={!canRemove} onClick={() => void save('remove')}>{t('settings.common.actions.delete')}</Button> : null}
        </> : null}
      </div>
    </SettingsControlGroup>
      </CollapsibleContent>
    </Collapsible>
  );
};
