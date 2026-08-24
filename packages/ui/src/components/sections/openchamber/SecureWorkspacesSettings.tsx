import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';
import { sessionEvents } from '@/lib/sessionEvents';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useWorkspaceReauth } from '@/components/workspaces/WorkspaceReauth';
import type { WorkspaceProviderEnvironment, WorkspaceProviderKind, WorkspaceReadinessResult, WorkspaceReauthProofResult, WorkspaceSetupResult } from '@/lib/api/types';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';

type SecureWorkspaceSettingsPayload = {
  secureWorkspacesEnabled?: boolean;
  secureWorkspacesDefaultProvider?: WorkspaceProviderKind;
  secureWorkspacesImage?: string;
  secureWorkspacesKubernetesContext?: string;
  secureWorkspacesKubernetesNamespace?: string;
  secureWorkspacesAllowedImages?: string;
  secureWorkspacesGatewayImage?: string;
  secureWorkspacesEgressMode?: 'managed' | 'external';
  secureWorkspacesEgressPreset?: 'restricted' | 'custom';
  secureWorkspacesEgressAllowedDomains?: string;
  secureWorkspacesEgressAllowedCIDRs?: string;
  secureWorkspacesEgressAllowedPorts?: string;
  secureWorkspacesEgressProxyUrl?: string;
  secureWorkspacesEgressProxyCIDR?: string;
  secureWorkspacesEgressDnsCIDRs?: string;
  secureWorkspacesEgressNoProxy?: string;
  secureWorkspacesDockerMemoryLimit?: string;
  secureWorkspacesDockerCpuLimit?: string;
  secureWorkspacesDockerPidsLimit?: number;
  secureWorkspacesKubernetesConnectivity?: 'port-forward' | 'ingress';
  secureWorkspacesKubernetesStorage?: string;
  secureWorkspacesKubernetesCpuRequest?: string;
  secureWorkspacesKubernetesMemoryRequest?: string;
  secureWorkspacesKubernetesCpuLimit?: string;
  secureWorkspacesKubernetesMemoryLimit?: string;
  secureWorkspacesKubernetesIngressClassName?: string;
  secureWorkspacesKubernetesIngressHostTemplate?: string;
  secureWorkspacesKubernetesIngressPathTemplate?: string;
  secureWorkspacesKubernetesIngressTlsMode?: 'existing-secret' | 'cert-manager';
  secureWorkspacesKubernetesIngressTlsSecretName?: string;
  secureWorkspacesKubernetesIngressClusterIssuer?: string;
  secureWorkspacesKubernetesIngressNamespaceSelector?: string;
  secureWorkspacesKubernetesIngressPodSelector?: string;
  secureWorkspacesKubernetesIngressAnnotations?: string;
  secureWorkspacesAppleMemoryLimit?: string;
  secureWorkspacesAppleCpuLimit?: string;
  secureWorkspacesRetentionPreserveOnDelete?: boolean;
  secureWorkspacesModelAuth?: 'none' | 'explicit-opencode-auth-content';
};

const DEFAULT_NAMESPACE = 'openchamber-workspaces';
const DEFAULT_NO_PROXY = '127.0.0.1,localhost';

/**
 * Turns a setup result into what to tell the operator. An image the cluster cannot pull
 * is called out separately: the failure is a setting they own, not anything the probe
 * learned about the cluster, and reporting it as an isolation problem sends them
 * looking in the wrong place.
 */
function setupOutcome(
  t: (key: never) => string,
  action: 'create-namespace' | 'check-isolation',
  result: WorkspaceSetupResult,
): { tone: 'ok' | 'warn'; text: string } {
  if (action === 'create-namespace') {
    return { tone: 'ok', text: t((result.created ? 'settings.workspaces.setup.namespaceCreated' : 'settings.workspaces.setup.namespaceExists') as never) };
  }
  if (result.imageUnavailable === true) {
    return { tone: 'warn', text: t('settings.workspaces.setup.imageUnpullable' as never) };
  }
  if (result.verdict === 'enforced') return { tone: 'ok', text: t('settings.workspaces.setup.isolationEnforced' as never) };
  if (result.verdict === 'not-enforced') {
    return { tone: 'warn', text: `${t('settings.workspaces.setup.isolationMissing' as never)} ${t('settings.workspaces.setup.isolationDockerDesktop' as never)}` };
  }
  return { tone: 'warn', text: result.diagnostics?.[0] ?? t('settings.workspaces.setup.isolationUnknown' as never) };
}

/** What choosing this provider means. Explanation, so it lives behind the info icon. */
function providerChoiceGuidance(t: (key: never) => string, provider: WorkspaceProviderKind): string | undefined {
  if (provider === 'docker') return t('settings.workspaces.where.dockerRecommended' as never);
  if (provider === 'kubernetes') return t('settings.workspaces.where.kubernetesWhen' as never);
  return undefined;
}

export const SecureWorkspacesSettings: React.FC = () => {
  const { t } = useI18n();
  const runtimeAPIs = useRuntimeAPIs();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [readiness, setReadiness] = React.useState<WorkspaceReadinessResult | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [activationMessage, setActivationMessage] = React.useState('');
  const reauth = useWorkspaceReauth();
  const [clusters, setClusters] = React.useState<WorkspaceProviderEnvironment | null>(null);
  const [setupBusy, setSetupBusy] = React.useState<string>('');
  const [setupMessage, setSetupMessage] = React.useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const dirtyRef = React.useRef(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<Required<SecureWorkspaceSettingsPayload>>({
    secureWorkspacesEnabled: false,
    secureWorkspacesDefaultProvider: 'docker',
    secureWorkspacesImage: '',
    secureWorkspacesKubernetesContext: '',
    secureWorkspacesKubernetesNamespace: DEFAULT_NAMESPACE,
    secureWorkspacesAllowedImages: '',
    secureWorkspacesGatewayImage: '',
    secureWorkspacesEgressMode: 'managed',
    secureWorkspacesEgressPreset: 'restricted',
    secureWorkspacesEgressAllowedDomains: '',
    secureWorkspacesEgressAllowedCIDRs: '',
    secureWorkspacesEgressAllowedPorts: '80,443',
    secureWorkspacesEgressProxyUrl: '',
    secureWorkspacesEgressProxyCIDR: '',
    secureWorkspacesEgressDnsCIDRs: '',
    secureWorkspacesEgressNoProxy: DEFAULT_NO_PROXY,
    secureWorkspacesDockerMemoryLimit: '',
    secureWorkspacesDockerCpuLimit: '',
    secureWorkspacesDockerPidsLimit: 512,
    secureWorkspacesKubernetesConnectivity: 'port-forward',
    secureWorkspacesKubernetesStorage: '8Gi',
    secureWorkspacesKubernetesCpuRequest: '250m',
    secureWorkspacesKubernetesMemoryRequest: '512Mi',
    secureWorkspacesKubernetesCpuLimit: '2',
    secureWorkspacesKubernetesMemoryLimit: '4Gi',
    secureWorkspacesKubernetesIngressClassName: '',
    secureWorkspacesKubernetesIngressHostTemplate: '',
    secureWorkspacesKubernetesIngressPathTemplate: '/',
    secureWorkspacesKubernetesIngressTlsMode: 'existing-secret',
    secureWorkspacesKubernetesIngressTlsSecretName: '',
    secureWorkspacesKubernetesIngressClusterIssuer: '',
    secureWorkspacesKubernetesIngressNamespaceSelector: '{}',
    secureWorkspacesKubernetesIngressPodSelector: '{}',
    secureWorkspacesKubernetesIngressAnnotations: '{}',
    secureWorkspacesAppleMemoryLimit: '',
    secureWorkspacesAppleCpuLimit: '',
    secureWorkspacesRetentionPreserveOnDelete: false,
    secureWorkspacesModelAuth: 'explicit-opencode-auth-content',
  });

  // Readiness is the primary signal for this page: it answers "does this machine have
  // what it needs" without a step-up prompt, so the state is visible on arrival.
  const refreshCompatibility = React.useCallback(async (directory?: string) => {
    const workspaces = runtimeAPIs.workspaces;
    if (!workspaces) return;
    setChecking(true);
    try {
      const result = await workspaces.readiness({ directory: directory || undefined });
      setReadiness(result);
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.compatibility.failed'));
    } finally {
      setChecking(false);
    }
  }, [runtimeAPIs.workspaces, t]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await runtimeAPIs.settings.load();
        const loaded = (result.settings ?? {}) as SecureWorkspaceSettingsPayload;
        if (cancelled) return;
        // The disk load resolves asynchronously after mount; if the user has already
        // started editing, merging disk values here would silently wipe their input.
        if (dirtyRef.current) return;
        setSettings((current) => ({
          ...current,
          secureWorkspacesEnabled: loaded.secureWorkspacesEnabled === true,
          secureWorkspacesDefaultProvider: loaded.secureWorkspacesDefaultProvider === 'kubernetes'
            ? 'kubernetes'
            : loaded.secureWorkspacesDefaultProvider === 'apple-container' ? 'apple-container' : 'docker',
          secureWorkspacesImage: typeof loaded.secureWorkspacesImage === 'string' ? loaded.secureWorkspacesImage.trim() : '',
          secureWorkspacesKubernetesContext: typeof loaded.secureWorkspacesKubernetesContext === 'string' ? loaded.secureWorkspacesKubernetesContext : '',
          secureWorkspacesKubernetesNamespace: typeof loaded.secureWorkspacesKubernetesNamespace === 'string' && loaded.secureWorkspacesKubernetesNamespace.trim()
            ? loaded.secureWorkspacesKubernetesNamespace.trim() : DEFAULT_NAMESPACE,
          ...Object.fromEntries(Object.keys(current).filter((key) => key !== 'secureWorkspacesEnabled' && key !== 'secureWorkspacesDefaultProvider' && key !== 'secureWorkspacesImage' && Object.hasOwn(loaded, key)).map((key) => [key, loaded[key as keyof SecureWorkspaceSettingsPayload]])),
        }));
      } finally {
        if (!cancelled) setLoading(false);
      }
      // Deliberately not awaited: readiness asks Docker and the cluster what they can
      // do, which takes seconds, and none of it is needed to show settings already
      // read from disk. Awaiting it left the page blank for the whole probe.
      if (!cancelled) void refreshCompatibility(opencodeClient.getDirectory() ?? undefined);
    })();
    return () => { cancelled = true; };
  }, [refreshCompatibility, runtimeAPIs.settings]);

  const reauthenticate = reauth.requestProof;

  function save(changes: Partial<SecureWorkspaceSettingsPayload>) {
    dirtyRef.current = true;
    setSettings((current) => ({ ...current, ...changes }));
  }

  function editSettings(updater: (current: Required<SecureWorkspaceSettingsPayload>) => Required<SecureWorkspaceSettingsPayload>) {
    dirtyRef.current = true;
    setSettings(updater);
  }

  /**
   * Writes a change immediately instead of staging it for the Save button. Editing a
   * text field is a draft the operator is still composing, but pressing a button that
   * names an outcome is not: it left values on screen that were never written, and the
   * next action still used what was on disk.
   */
  async function applyNow(changes: Partial<SecureWorkspaceSettingsPayload>) {
    // Only the changed keys are sent. Submitting the whole form wrote whatever the local
    // state happened to hold, and the local state starts from defaults — so an action
    // taken before the disk values arrived, or after an edit suppressed that load, saved
    // `enabled: false` over a working configuration and quietly disabled the feature.
    setSettings((current) => ({ ...current, ...changes }));
    let proof: WorkspaceReauthProofResult | null;
    try {
      proof = await reauthenticate('workspace.configure', 'host', { activate: false, changes });
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.reauth.failed'));
      return false;
    }
    if (!proof) return false;
    setSaving(true);
    reportSettingsSaveState('saving');
    try {
      const configured = await runtimeAPIs.workspaces?.updateSettings({ changes, activate: false, reauthProof: proof.proof, reauthNonce: proof.nonce });
      if (!configured) throw new Error(t('settings.workspaces.compatibility.failed'));
      dirtyRef.current = false;
      reportSettingsSaveState('saved');
      sessionEvents.publishWorkspaceEvent({ type: 'policy-changed' });
      if (configured.compatibility) setReadiness((current) => (current ? { ...current, ...configured.compatibility } : current));
      return true;
    } catch (error) {
      reportSettingsSaveState('error');
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.compatibility.failed'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function applySettings() {
    const changes = settings;
    const configurePayload = { activate: false, changes };
    let proof: WorkspaceReauthProofResult | null;
    try {
      proof = await reauthenticate('workspace.configure', 'host', configurePayload);
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.reauth.failed'));
      return;
    }
    if (!proof) return;
    setSaving(true);
    reportSettingsSaveState('saving');
    try {
      const configured = await runtimeAPIs.workspaces?.updateSettings({ changes, activate: false, reauthProof: proof.proof, reauthNonce: proof.nonce });
      if (!configured) throw new Error(t('settings.workspaces.compatibility.failed'));
      reportSettingsSaveState('saved');
      sessionEvents.publishWorkspaceEvent({ type: 'policy-changed' });
      if (configured.compatibility) setReadiness((current) => (current ? { ...current, ...configured.compatibility } : current));
    } catch (error) {
      reportSettingsSaveState('error');
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.compatibility.failed'));
    } finally {
      setSaving(false);
    }
  }

  /** Completes one setup requirement the app can do on the person's behalf. */
  async function runSetupAction(provider: WorkspaceProviderKind, action: 'create-namespace' | 'check-isolation') {
    if (!runtimeAPIs.workspaces?.setupProvider) return;
    setSetupBusy(action);
    setSetupMessage(null);
    try {
      const result = await runtimeAPIs.workspaces.setupProvider({ provider, action });
      // Reported twice on purpose: the message belongs with the step, but a toast
      // outlives any re-render the refresh below causes, so an answer cannot vanish
      // before it has been read.
      const outcome = setupOutcome(t, action, result);
      setSetupMessage(outcome);
      if (outcome.tone === 'ok') toast.success(outcome.text);
      else toast.error(outcome.text);
      await refreshCompatibility(opencodeClient.getDirectory() ?? undefined);
    } catch (error) {
      setSetupMessage({ tone: 'warn', text: error instanceof Error ? error.message : t('settings.workspaces.setup.actionFailed') });
    } finally {
      setSetupBusy('');
    }
  }

  // kubeconfig already names the clusters this host can reach, so they are offered
  // rather than typed. Loaded only for the provider that has them.
  React.useEffect(() => {
    if (settings.secureWorkspacesDefaultProvider !== 'kubernetes' || !runtimeAPIs.workspaces?.providerEnvironment) {
      setClusters(null);
      return;
    }
    let cancelled = false;
    runtimeAPIs.workspaces.providerEnvironment({ provider: 'kubernetes' })
      .then((result) => { if (!cancelled) setClusters(result); })
      .catch(() => { if (!cancelled) setClusters(null); });
    return () => { cancelled = true; };
  }, [settings.secureWorkspacesDefaultProvider, runtimeAPIs.workspaces]);

  /** Selecting a cluster carries its namespace, because kubeconfig binds the two. */
  async function selectCluster(name: string) {
    const chosen = clusters?.contexts.find((entry) => entry.name === name);
    const changes: Partial<SecureWorkspaceSettingsPayload> = { secureWorkspacesKubernetesContext: name };
    if (chosen?.namespace) changes.secureWorkspacesKubernetesNamespace = chosen.namespace;
    // Persisted before re-reading readiness, which would otherwise report on the cluster
    // that was still stored rather than the one just chosen.
    if (await applyNow(changes)) await refreshCompatibility(opencodeClient.getDirectory() ?? undefined);
  }

  async function activateWorkspaces() {
    if (!runtimeAPIs.workspaces) return;
    setSaving(true);
    setActivationMessage('');
    try {
      const payload = { activate: true, changes: {} };
      const proof = await reauthenticate('workspace.configure', 'host', payload);
      if (!proof) return;
      const result = await runtimeAPIs.workspaces.updateSettings({ changes: {}, activate: true, reauthProof: proof.proof, reauthNonce: proof.nonce });
      if (result.compatibility) setReadiness((current) => (current ? { ...current, ...result.compatibility } : current));
      setActivationMessage(result.manualRestartRequired
        ? t('settings.workspaces.compatibility.manualRestart')
        : result.active || result.compatibility?.active
          ? t('settings.workspaces.compatibility.activated')
          : t('settings.workspaces.compatibility.pending'));
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.compatibility.failed'));
    } finally {
      setSaving(false);
    }
  }


  if (loading) return null;

  const providerReadiness = new Map((readiness?.providers ?? []).map((entry) => [entry.provider, entry]));
  const availableProviders = (['docker', 'apple-container', 'kubernetes'] as const)
    .filter((provider) => !readiness?.platformProviders || readiness.platformProviders.includes(provider));
  const selectedProvider = settings.secureWorkspacesDefaultProvider;
  const runtimeReady = providerReadiness.get(selectedProvider)?.available === true;
  const activated = readiness?.active === true;
  const ready = runtimeReady && settings.secureWorkspacesEnabled && activated;
  const runtimeRemediation = providerRemediation(selectedProvider, providerReadiness.get(selectedProvider)?.code);
  const providerLabel = (provider: WorkspaceProviderKind) => provider === 'apple-container'
    ? t('settings.workspaces.provider.appleContainer')
    : provider === 'kubernetes' ? t('settings.workspaces.provider.kubernetes') : t('settings.workspaces.provider.docker');
  const selectedSteps = providerReadiness.get(selectedProvider)?.steps ?? [];
  const setupComplete = runtimeReady && selectedSteps.length > 0 && selectedSteps.every((step) => step.status === 'satisfied');
  // Empty means the built-in pinned images; anything else was typed in and can be undone.
  const usesCustomImages = Boolean(settings.secureWorkspacesImage || settings.secureWorkspacesGatewayImage || settings.secureWorkspacesAllowedImages);
  const doneMark = <span className={SETTINGS_HELPER_CLASS} style={{ color: 'var(--status-success)' }}>{t('settings.workspaces.setup.done')}</span>;

  return (
    <>
    <SettingsPageLayout
      title={t('settings.page.workspaces.title')}
      description={t('settings.workspaces.description')}
      headerEnd={<Button size="sm" onClick={() => void applySettings()} disabled={saving}>{t('settings.common.actions.saveChanges')}</Button>}
      showSaveStatus
    >
      <SettingsSection
        title={t('settings.workspaces.setup.title')}
        description={ready ? t('settings.workspaces.setup.readyHint') : t('settings.workspaces.setup.notReadyHint')}
        divider={false}
        settingsItem="workspaces.setup"
      >
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsFieldRow
            label={t('settings.workspaces.setup.stepRuntime')}
            description={runtimeReady ? undefined : readiness === null ? t('settings.workspaces.setup.checking') : (runtimeRemediation ? t(runtimeRemediation) : t('settings.workspaces.status.unavailable'))}
          >
            {runtimeReady ? doneMark : (
              <Button size="sm" variant="outline" onClick={() => void refreshCompatibility(opencodeClient.getDirectory() ?? undefined)} disabled={checking}>
                {checking ? t('settings.workspaces.setup.checking') : t('settings.workspaces.setup.recheck')}
              </Button>
            )}
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t('settings.workspaces.setup.stepEnable')}
            description={settings.secureWorkspacesEnabled ? undefined : t('settings.workspaces.setup.stepEnableHint')}
          >
            {settings.secureWorkspacesEnabled ? doneMark : (
              <Button size="sm" onClick={() => void applyNow({ secureWorkspacesEnabled: true })}>{t('settings.workspaces.setup.turnOn')}</Button>
            )}
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t('settings.workspaces.setup.stepActivate')}
            description={activated ? undefined : (activationMessage || t('settings.workspaces.setup.stepActivateHint'))}
          >
            {activated ? doneMark : (
              <Button size="sm" onClick={() => void activateWorkspaces()} disabled={saving || !settings.secureWorkspacesEnabled}>{t('settings.workspaces.compatibility.activate')}</Button>
            )}
          </SettingsFieldRow>
        </div>
      </SettingsSection>

      {selectedSteps.length > 0 ? (
        <SettingsSection
          title={setupComplete
            ? t('settings.workspaces.setup.pathReadyTitle', { provider: providerLabel(selectedProvider) })
            : t('settings.workspaces.setup.pathTitle', { provider: providerLabel(selectedProvider) })}
          description={setupComplete ? t('settings.workspaces.setup.pathReadyHint') : t('settings.workspaces.setup.pathHint')}
          settingsItem="workspaces.setup.path"
        >
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {selectedSteps.map((step, index) => {
              const remediation = step.status === 'blocked' ? providerRemediation(selectedProvider, step.code) : null;
              const busy = setupBusy === step.action;
              return (
                <SettingsFieldRow
                  key={step.id}
                  label={`${index + 1}. ${t(`settings.workspaces.setup.step.${selectedProvider}.${step.id}` as never)}`}
                  info={t(`settings.workspaces.setup.stepInfo.${selectedProvider}.${step.id}` as never)}
                  description={remediation ? t(remediation) : undefined}
                >
                  {step.id === 'cluster' && (clusters?.contexts.length ?? 0) > 0 ? (
                    <SettingsChipGroup
                      aria-label={t('settings.workspaces.setup.step.kubernetes.cluster')}
                      value={settings.secureWorkspacesKubernetesContext || clusters?.currentContext || ''}
                      options={(clusters?.contexts ?? []).map((entry) => ({ value: entry.name, label: entry.name }))}
                      onChange={(value) => void selectCluster(value)}
                    />
                  ) : step.status === 'satisfied' ? doneMark : step.action && step.status !== 'pending' ? (
                    <Button size="sm" variant="outline" onClick={() => void runSetupAction(selectedProvider, step.action!)} disabled={busy || setupBusy !== ''}>
                      {busy ? t('settings.workspaces.setup.working') : t(`settings.workspaces.setup.action.${step.action}` as never)}
                    </Button>
                  ) : null}
                </SettingsFieldRow>
              );
            })}
          </div>
          {setupMessage ? (
            <p className={cn(SETTINGS_HELPER_CLASS, setupMessage.tone === 'warn' && 'text-[var(--status-warning)]')}>{setupMessage.text}</p>
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t('settings.workspaces.where.title')}
        info={t('settings.workspaces.where.description')}
        settingsItem="workspaces.providers"
      >
        <SettingsRadioGroup aria-label={t('settings.workspaces.where.title')}>
          {availableProviders.map((provider) => {
            const entry = providerReadiness.get(provider);
            const remediation = entry && !entry.available ? providerRemediation(provider, entry.code) : null;
            return (
              <SettingsRadioOption
                key={provider}
                selected={selectedProvider === provider}
                onSelect={() => void save({ secureWorkspacesDefaultProvider: provider })}
                label={providerLabel(provider)}
                ariaLabel={providerLabel(provider)}
                info={providerChoiceGuidance(t, provider)}
                description={entry === undefined || entry.available
                  ? undefined
                  : remediation ? t(remediation) : t('settings.workspaces.status.unavailable')}
              />
            );
          })}
        </SettingsRadioGroup>
      </SettingsSection>

      <SettingsSection
        title={t('settings.workspaces.safety.title')}
        info={t('settings.workspaces.safety.description')}
        settingsItem="workspaces.safety"
      >
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsFieldRow label={t('settings.workspaces.safety.filesLabel')} info={t('settings.workspaces.safety.filesText')}>
            <span className={SETTINGS_HELPER_CLASS}>{t('settings.workspaces.safety.filesValue')}</span>
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t('settings.workspaces.safety.internetLabel')}
            info={settings.secureWorkspacesEgressMode === 'managed' ? t('settings.workspaces.safety.internetRestricted') : t('settings.workspaces.safety.internetProxy')}
          >
            <span className={SETTINGS_HELPER_CLASS}>
              {settings.secureWorkspacesEgressMode === 'managed' ? t('settings.workspaces.safety.internetValueRestricted') : t('settings.workspaces.safety.internetValueProxy')}
            </span>
          </SettingsFieldRow>
          <SettingsCheckboxRow
            checked={settings.secureWorkspacesRetentionPreserveOnDelete}
            onChange={(checked) => void save({ secureWorkspacesRetentionPreserveOnDelete: checked })}
            label={t('settings.workspaces.retention.preserve')}
            ariaLabel={t('settings.workspaces.retention.preserve')}
            description={settings.secureWorkspacesRetentionPreserveOnDelete ? t('settings.workspaces.retention.warning') : undefined}
            settingsItem="workspaces.retention"
          />
        </div>
      </SettingsSection>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <SettingsSection
          // The heading itself is the disclosure: the chevron sits with the words it
          // acts on, and the whole title is the hit target instead of a distant icon.
          title={(
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="group flex items-center gap-1.5 text-left"
                aria-expanded={advancedOpen}
                aria-label={advancedOpen ? t('settings.workspaces.advanced.hide') : t('settings.workspaces.advanced.reveal')}
              >
                <span className={SETTINGS_SECTION_TITLE_CLASS}>{t('settings.workspaces.advanced.title')}</span>
                <Icon
                  name={advancedOpen ? 'arrow-up-s' : 'arrow-down-s'}
                  className="size-4 text-muted-foreground transition-colors group-hover:text-foreground"
                />
              </button>
            </CollapsibleTrigger>
          )}
          info={t('settings.workspaces.advanced.description')}
          settingsItem="workspaces.advanced"
          contentClassName={advancedOpen ? undefined : 'hidden'}
        >
          <CollapsibleContent className="space-y-6">
            <SettingsControlGroup title={t('settings.workspaces.advanced.credentialsGroup')} info={t('settings.workspaces.safety.credentialsHint')} settingsItem="workspaces.policy">
              <SettingsRadioGroup aria-label={t('settings.workspaces.advanced.credentialsGroup')}>
                <SettingsRadioOption
                  selected={settings.secureWorkspacesModelAuth === 'explicit-opencode-auth-content'}
                  onSelect={() => void save({ secureWorkspacesModelAuth: 'explicit-opencode-auth-content' })}
                  label={t('settings.workspaces.credentials.explicit')}
                  ariaLabel={t('settings.workspaces.credentials.explicit')}
                  description={t('settings.workspaces.credentials.explicitHint')}
                />
                <SettingsRadioOption
                  selected={settings.secureWorkspacesModelAuth === 'none'}
                  onSelect={() => void save({ secureWorkspacesModelAuth: 'none' })}
                  label={t('settings.workspaces.credentials.none')}
                  ariaLabel={t('settings.workspaces.credentials.none')}
                  description={t('settings.workspaces.credentials.noneHint')}
                />
              </SettingsRadioGroup>
            </SettingsControlGroup>

            <SettingsControlGroup title={t('settings.workspaces.advanced.imagesGroup')} info={t('settings.workspaces.advanced.imagesHint')}>
              <SettingsTwoColumn>
                <SettingsStackedField label={t('settings.workspaces.image')} settingsItem="workspaces.image">
                  <Input className="h-8" value={settings.secureWorkspacesImage} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesImage: event.target.value }))} onBlur={() => void save({ secureWorkspacesImage: settings.secureWorkspacesImage.trim() })} />
                </SettingsStackedField>
                <SettingsStackedField label={t('settings.workspaces.allowedImages')} info={t('settings.workspaces.allowedImagesHint')}>
                  <Input className="h-8" value={settings.secureWorkspacesAllowedImages} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesAllowedImages: event.target.value }))} onBlur={() => void save({ secureWorkspacesAllowedImages: settings.secureWorkspacesAllowedImages.trim() })} />
                </SettingsStackedField>
              </SettingsTwoColumn>
              {usesCustomImages ? (
                <SettingsFieldRow label={t('settings.workspaces.advanced.customImages')} info={t('settings.workspaces.advanced.customImagesHint')}>
                  <Button size="sm" variant="outline" onClick={() => void applyNow({ secureWorkspacesImage: '', secureWorkspacesGatewayImage: '', secureWorkspacesAllowedImages: '' }).then((ok) => { if (ok) void refreshCompatibility(opencodeClient.getDirectory() ?? undefined); })}>
                    {t('settings.workspaces.advanced.useBuiltInImages')}
                  </Button>
                </SettingsFieldRow>
              ) : null}
            </SettingsControlGroup>

            <SettingsControlGroup title={t('settings.workspaces.advanced.limitsGroup')} info={t('settings.workspaces.advanced.limitsHint')}>
              <SettingsTwoColumn>
                {selectedProvider === 'docker' ? (
                  <>
                    <SettingsStackedField label={t('settings.workspaces.docker.memory')}><Input className="h-8" value={settings.secureWorkspacesDockerMemoryLimit} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesDockerMemoryLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesDockerMemoryLimit: settings.secureWorkspacesDockerMemoryLimit.trim() })} /></SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.docker.cpu')}><Input className="h-8" value={settings.secureWorkspacesDockerCpuLimit} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesDockerCpuLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesDockerCpuLimit: settings.secureWorkspacesDockerCpuLimit.trim() })} /></SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.docker.pids')}><Input className="h-8" type="number" min={1} value={settings.secureWorkspacesDockerPidsLimit} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesDockerPidsLimit: Number(event.target.value) }))} onBlur={() => void save({ secureWorkspacesDockerPidsLimit: settings.secureWorkspacesDockerPidsLimit })} /></SettingsStackedField>
                  </>
                ) : null}
                {selectedProvider === 'apple-container' ? (
                  <>
                    <SettingsStackedField label={t('settings.workspaces.apple.memory')}><Input className="h-8" value={settings.secureWorkspacesAppleMemoryLimit} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesAppleMemoryLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesAppleMemoryLimit: settings.secureWorkspacesAppleMemoryLimit.trim() })} /></SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.apple.cpu')}><Input className="h-8" value={settings.secureWorkspacesAppleCpuLimit} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesAppleCpuLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesAppleCpuLimit: settings.secureWorkspacesAppleCpuLimit.trim() })} /></SettingsStackedField>
                  </>
                ) : null}
                {selectedProvider === 'kubernetes' ? (
                  <>
                    <SettingsStackedField label={t('settings.workspaces.kubernetes.storage')}><Input className="h-8" value={settings.secureWorkspacesKubernetesStorage} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesStorage: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesStorage: settings.secureWorkspacesKubernetesStorage.trim() })} /></SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.kubernetes.cpuRequest')}><Input className="h-8" value={settings.secureWorkspacesKubernetesCpuRequest} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesCpuRequest: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesCpuRequest: settings.secureWorkspacesKubernetesCpuRequest.trim() })} /></SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.kubernetes.memoryRequest')}><Input className="h-8" value={settings.secureWorkspacesKubernetesMemoryRequest} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesMemoryRequest: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesMemoryRequest: settings.secureWorkspacesKubernetesMemoryRequest.trim() })} /></SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.kubernetes.cpuLimit')}><Input className="h-8" value={settings.secureWorkspacesKubernetesCpuLimit} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesCpuLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesCpuLimit: settings.secureWorkspacesKubernetesCpuLimit.trim() })} /></SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.kubernetes.memoryLimit')}><Input className="h-8" value={settings.secureWorkspacesKubernetesMemoryLimit} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesMemoryLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesMemoryLimit: settings.secureWorkspacesKubernetesMemoryLimit.trim() })} /></SettingsStackedField>
                  </>
                ) : null}
              </SettingsTwoColumn>
            </SettingsControlGroup>

            <SettingsControlGroup title={t('settings.workspaces.advanced.networkGroup')} info={t('settings.workspaces.advanced.egressHint')} settingsItem="workspaces.egress">
              <div className={SETTINGS_FIELDS_STACK_CLASS}>
                <SettingsChipGroup
                  aria-label={t('settings.workspaces.egress.mode')}
                  value={settings.secureWorkspacesEgressMode}
                  onChange={(value) => void save({ secureWorkspacesEgressMode: value })}
                  options={[
                    { value: 'managed' as const, label: t('settings.workspaces.egress.managed') },
                    { value: 'external' as const, label: t('settings.workspaces.egress.external') },
                  ]}
                />
                <SettingsTwoColumn>
                  {settings.secureWorkspacesEgressMode === 'managed' ? (
                    <>
                      <SettingsStackedField label={t('settings.workspaces.egress.allowedDomains')} info={t('settings.workspaces.advanced.domainsHint')}><Input className="h-8" value={settings.secureWorkspacesEgressAllowedDomains} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesEgressAllowedDomains: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressAllowedDomains: settings.secureWorkspacesEgressAllowedDomains.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.egress.allowedCIDRs')}><Input className="h-8" value={settings.secureWorkspacesEgressAllowedCIDRs} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesEgressAllowedCIDRs: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressAllowedCIDRs: settings.secureWorkspacesEgressAllowedCIDRs.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.egress.allowedPorts')}><Input className="h-8" value={settings.secureWorkspacesEgressAllowedPorts} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesEgressAllowedPorts: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressAllowedPorts: settings.secureWorkspacesEgressAllowedPorts.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.egress.gatewayImage')}><Input className="h-8" value={settings.secureWorkspacesGatewayImage} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesGatewayImage: event.target.value }))} onBlur={() => void save({ secureWorkspacesGatewayImage: settings.secureWorkspacesGatewayImage.trim() })} /></SettingsStackedField>
                    </>
                  ) : (
                    <>
                      <SettingsStackedField label={t('settings.workspaces.egress.httpProxy')}><Input className="h-8" value={settings.secureWorkspacesEgressProxyUrl} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesEgressProxyUrl: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressProxyUrl: settings.secureWorkspacesEgressProxyUrl.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.egress.proxyCIDR')}><Input className="h-8" value={settings.secureWorkspacesEgressProxyCIDR} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesEgressProxyCIDR: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressProxyCIDR: settings.secureWorkspacesEgressProxyCIDR.trim() })} /></SettingsStackedField>
                    </>
                  )}
                  <SettingsStackedField label={t('settings.workspaces.egress.noProxy')}><Input className="h-8" value={settings.secureWorkspacesEgressNoProxy} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesEgressNoProxy: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressNoProxy: settings.secureWorkspacesEgressNoProxy.trim() || DEFAULT_NO_PROXY })} /></SettingsStackedField>
                  <SettingsStackedField label={t('settings.workspaces.egress.dnsCIDRs')}><Input className="h-8" value={settings.secureWorkspacesEgressDnsCIDRs} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesEgressDnsCIDRs: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressDnsCIDRs: settings.secureWorkspacesEgressDnsCIDRs.trim() })} /></SettingsStackedField>
                </SettingsTwoColumn>
              </div>
            </SettingsControlGroup>

            {selectedProvider === 'kubernetes' ? (
              <SettingsControlGroup title={t('settings.workspaces.advanced.clusterGroup')} info={t('settings.workspaces.advanced.clusterHint')}>
                <div className={SETTINGS_FIELDS_STACK_CLASS}>
                  <SettingsTwoColumn>
                    <SettingsStackedField label={t('settings.workspaces.kubernetes.context')} settingsItem="workspaces.kubernetes">
                      <Input className="h-8" value={settings.secureWorkspacesKubernetesContext} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesContext: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesContext: settings.secureWorkspacesKubernetesContext.trim() })} />
                    </SettingsStackedField>
                    <SettingsStackedField label={t('settings.workspaces.kubernetes.namespace')}>
                      <Input className="h-8" value={settings.secureWorkspacesKubernetesNamespace} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesNamespace: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesNamespace: settings.secureWorkspacesKubernetesNamespace.trim() || DEFAULT_NAMESPACE })} />
                    </SettingsStackedField>
                  </SettingsTwoColumn>
                  <SettingsChipGroup
                    aria-label={t('settings.workspaces.kubernetes.connectivity')}
                    value={settings.secureWorkspacesKubernetesConnectivity}
                    onChange={(value) => void save({ secureWorkspacesKubernetesConnectivity: value })}
                    options={[
                      { value: 'port-forward' as const, label: t('settings.workspaces.kubernetes.portForward') },
                      { value: 'ingress' as const, label: t('settings.workspaces.kubernetes.ingress') },
                    ]}
                  />
                  {settings.secureWorkspacesKubernetesConnectivity === 'ingress' ? (
                    <SettingsTwoColumn>
                      <SettingsStackedField label={t('settings.workspaces.kubernetes.ingressClass')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressClassName} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressClassName: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressClassName: settings.secureWorkspacesKubernetesIngressClassName.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.kubernetes.hostTemplate')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressHostTemplate} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressHostTemplate: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressHostTemplate: settings.secureWorkspacesKubernetesIngressHostTemplate.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.kubernetes.pathTemplate')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressPathTemplate} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressPathTemplate: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressPathTemplate: settings.secureWorkspacesKubernetesIngressPathTemplate.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.kubernetes.namespaceSelector')}><Input className="h-8 font-mono" value={settings.secureWorkspacesKubernetesIngressNamespaceSelector} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressNamespaceSelector: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressNamespaceSelector: settings.secureWorkspacesKubernetesIngressNamespaceSelector.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.kubernetes.podSelector')}><Input className="h-8 font-mono" value={settings.secureWorkspacesKubernetesIngressPodSelector} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressPodSelector: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressPodSelector: settings.secureWorkspacesKubernetesIngressPodSelector.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.kubernetes.annotations')}><Input className="h-8 font-mono" value={settings.secureWorkspacesKubernetesIngressAnnotations} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressAnnotations: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressAnnotations: settings.secureWorkspacesKubernetesIngressAnnotations.trim() })} /></SettingsStackedField>
                      <SettingsStackedField label={t('settings.workspaces.kubernetes.tlsMode')}>
                        <SettingsChipGroup
                          aria-label={t('settings.workspaces.kubernetes.tlsMode')}
                          value={settings.secureWorkspacesKubernetesIngressTlsMode}
                          onChange={(value) => void save({ secureWorkspacesKubernetesIngressTlsMode: value })}
                          options={[
                            { value: 'existing-secret' as const, label: t('settings.workspaces.kubernetes.existingSecret') },
                            { value: 'cert-manager' as const, label: t('settings.workspaces.kubernetes.certManager') },
                          ]}
                        />
                      </SettingsStackedField>
                      {settings.secureWorkspacesKubernetesIngressTlsMode === 'existing-secret'
                        ? <SettingsStackedField label={t('settings.workspaces.kubernetes.tlsSecret')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressTlsSecretName} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressTlsSecretName: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressTlsSecretName: settings.secureWorkspacesKubernetesIngressTlsSecretName.trim() })} /></SettingsStackedField>
                        : <SettingsStackedField label={t('settings.workspaces.kubernetes.clusterIssuer')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressClusterIssuer} onChange={(event) => editSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressClusterIssuer: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressClusterIssuer: settings.secureWorkspacesKubernetesIngressClusterIssuer.trim() })} /></SettingsStackedField>}
                    </SettingsTwoColumn>
                  ) : null}
                </div>
              </SettingsControlGroup>
            ) : null}
          </CollapsibleContent>
        </SettingsSection>
      </Collapsible>

    </SettingsPageLayout>
    {reauth.dialog}
    </>
  );
};

function providerRemediation(provider: WorkspaceProviderKind, code?: string) {
  switch (code) {
    case 'WORKSPACE_PROVIDER_CLI_MISSING':
      return provider === 'docker' ? 'settings.workspaces.remediation.docker.cliMissing' as const
        : provider === 'kubernetes' ? 'settings.workspaces.remediation.kubernetes.cliMissing' as const
        : 'settings.workspaces.remediation.apple.cliMissing' as const;
    case 'WORKSPACE_PROVIDER_DAEMON_UNAVAILABLE':
      return provider === 'docker' ? 'settings.workspaces.remediation.docker.daemonUnavailable' as const
        : provider === 'apple-container' ? 'settings.workspaces.remediation.apple.daemonUnavailable' as const
        : null;
    case 'WORKSPACE_PROVIDER_NOT_CONFIGURED':
      return provider === 'kubernetes' ? 'settings.workspaces.remediation.kubernetes.notConfigured' as const : null;
    case 'WORKSPACE_PROVIDER_CLUSTER_UNREACHABLE':
      return provider === 'kubernetes' ? 'settings.workspaces.remediation.kubernetes.clusterUnreachable' as const : null;
    case 'WORKSPACE_PROVIDER_NAMESPACE_MISSING':
      return provider === 'kubernetes' ? 'settings.workspaces.remediation.kubernetes.namespaceMissing' as const : null;
    case 'WORKSPACE_PROVIDER_UNSUPPORTED':
      return provider === 'apple-container' ? 'settings.workspaces.remediation.apple.unsupportedPlatform' as const : null;
    case 'WORKSPACE_POLICY_ERROR':
    case 'WORKSPACE_POLICY_INCOMPLETE':
      return 'settings.workspaces.remediation.policyIncomplete' as const;
    case 'WORKSPACE_PROVIDER_CAPABILITY_UNAVAILABLE':
      return provider === 'apple-container' ? 'settings.workspaces.remediation.apple.managedEgress' as const : null;
    default:
      return null;
  }
}
