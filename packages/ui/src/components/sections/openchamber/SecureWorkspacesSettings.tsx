import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { reportSettingsSaveState } from '@/lib/persistence';
import type { WorkspaceCompatibilityResult, WorkspacePrivilegedOperation, WorkspaceProviderKind, WorkspaceProviderValidationResult, WorkspaceReauthProofResult } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsFieldRow,
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

export const SecureWorkspacesSettings: React.FC = () => {
  const { t } = useI18n();
  const runtimeAPIs = useRuntimeAPIs();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [validating, setValidating] = React.useState<WorkspaceProviderKind | null>(null);
  const [providerStatus, setProviderStatus] = React.useState<Partial<Record<WorkspaceProviderKind, WorkspaceProviderValidationResult>>>({});
  const [providerErrors, setProviderErrors] = React.useState<Partial<Record<WorkspaceProviderKind, string>>>({});
  const [compatibility, setCompatibility] = React.useState<WorkspaceCompatibilityResult | null>(null);
  const [activationMessage, setActivationMessage] = React.useState('');
  const [reauthRequest, setReauthRequest] = React.useState<{
    operation: WorkspacePrivilegedOperation;
    project: string;
    payload: Record<string, unknown>;
    resolve: (proof: WorkspaceReauthProofResult | null) => void;
  } | null>(null);
  const [reauthPassword, setReauthPassword] = React.useState('');
  const [reauthBusy, setReauthBusy] = React.useState(false);
  const [reauthError, setReauthError] = React.useState('');
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
    secureWorkspacesModelAuth: 'none',
  });

  const refreshCompatibility = React.useCallback(async (directory?: string) => {
    const workspaces = runtimeAPIs.workspaces;
    if (!workspaces) return;
    try {
      setCompatibility(await workspaces.compatibility({ directory: directory || undefined }));
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.compatibility.failed'));
    }
  }, [runtimeAPIs.workspaces, t]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await runtimeAPIs.settings.load();
        const loaded = (result.settings ?? {}) as SecureWorkspaceSettingsPayload;
        if (cancelled) return;
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
        await refreshCompatibility(opencodeClient.getDirectory() ?? undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshCompatibility, runtimeAPIs.settings]);

  async function reauthenticate(operation: WorkspacePrivilegedOperation, project: string, payload: Record<string, unknown>) {
    if (!runtimeAPIs.workspaces) return null;
    return new Promise<WorkspaceReauthProofResult | null>((resolve) => {
      setReauthPassword('');
      setReauthError('');
      setReauthRequest({ operation, project, payload, resolve });
    });
  }

  function cancelReauthentication() {
    if (reauthBusy) return;
    reauthRequest?.resolve(null);
    setReauthRequest(null);
    setReauthPassword('');
    setReauthError('');
  }

  async function confirmReauthentication() {
    if (!reauthRequest || !runtimeAPIs.workspaces || reauthBusy) return;
    setReauthBusy(true);
    setReauthError('');
    try {
      const result = await runtimeAPIs.workspaces.reauthenticate({
        operation: reauthRequest.operation,
        project: reauthRequest.project,
        payload: reauthRequest.payload,
        password: reauthPassword || undefined,
      });
      reauthRequest.resolve(result);
      setReauthRequest(null);
      setReauthPassword('');
    } catch (error) {
      setReauthError(error instanceof Error ? error.message : t('settings.workspaces.reauth.failed'));
    } finally {
      setReauthBusy(false);
    }
  }

  async function save(changes: Partial<SecureWorkspaceSettingsPayload>) {
    const configurePayload = { activate: false, changes };
    let reauth: WorkspaceReauthProofResult | null;
    try {
      reauth = await reauthenticate('workspace.configure', 'host', configurePayload);
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : t('settings.workspaces.reauth.failed'));
      return;
    }
    if (!reauth) return;
    const previous = settings;
    setSettings((current) => ({ ...current, ...changes }));
    setSaving(true);
    reportSettingsSaveState('saving');
    try {
      const configured = await runtimeAPIs.workspaces?.updateSettings({ changes, activate: false, reauthProof: reauth.proof, reauthNonce: reauth.nonce });
      if (!configured) throw new Error(t('settings.workspaces.compatibility.failed'));
      reportSettingsSaveState('saved');
      if (configured.compatibility) setCompatibility(configured.compatibility);
    } catch {
      setSettings(previous);
      reportSettingsSaveState('error');
    } finally {
      setSaving(false);
    }
  }

  async function activateWorkspaces() {
    if (!runtimeAPIs.workspaces) return;
    setSaving(true);
    setActivationMessage('');
    try {
      const payload = { activate: true, changes: {} };
      const reauth = await reauthenticate('workspace.configure', 'host', payload);
      if (!reauth) return;
      const result = await runtimeAPIs.workspaces.updateSettings({ changes: {}, activate: true, reauthProof: reauth.proof, reauthNonce: reauth.nonce });
      if (result.compatibility) setCompatibility(result.compatibility);
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

  async function validate(provider: WorkspaceProviderKind) {
    if (!runtimeAPIs.workspaces) return;
    setValidating(provider);
    setProviderErrors((current) => ({ ...current, [provider]: undefined }));
    try {
      const reauth = await reauthenticate('workspace.validate', 'host', { provider });
      if (!reauth) return;
      const result = await runtimeAPIs.workspaces.validateProvider({
        provider,
        context: provider === 'kubernetes' ? settings.secureWorkspacesKubernetesContext : undefined,
        namespace: provider === 'kubernetes' ? settings.secureWorkspacesKubernetesNamespace : undefined,
        egressHttpProxy: settings.secureWorkspacesEgressProxyUrl,
        egressProxyCIDR: settings.secureWorkspacesEgressProxyCIDR,
        egressDnsCIDRs: settings.secureWorkspacesEgressDnsCIDRs,
        egressNoProxy: settings.secureWorkspacesEgressNoProxy,
        reauthProof: reauth.proof,
        reauthNonce: reauth.nonce,
      });
      setProviderStatus((current) => ({ ...current, [provider]: result }));
    } catch (error) {
      setProviderErrors((current) => ({ ...current, [provider]: error instanceof Error ? error.message : t('settings.workspaces.status.unavailable') }));
    } finally {
      setValidating(null);
    }
  }

  if (loading) return null;

  const compatibilityText = compatibility?.active
    ? t('settings.workspaces.compatibility.active')
    : compatibility?.configured
      ? compatibility.supported ? t('settings.workspaces.compatibility.configuredInactive') : t('settings.workspaces.compatibility.unsupported')
      : t('settings.workspaces.compatibility.notConfigured');

  return (
    <>
    <SettingsPageLayout title={t('settings.page.workspaces.title')} description={t('settings.workspaces.description')} showSaveStatus>
      <SettingsSection title={t('settings.workspaces.compatibility.title')} divider={false} settingsItem="workspaces.compatibility">
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsCheckboxRow
            checked={settings.secureWorkspacesEnabled}
            onChange={(checked) => void save({ secureWorkspacesEnabled: checked })}
            label={t('settings.workspaces.enable')}
            info={t('settings.workspaces.enableHint')}
            ariaLabel={t('settings.workspaces.enable')}
            settingsItem="workspaces.enable"
          />
          <SettingsFieldRow label={compatibilityText} description={compatibility?.error || activationMessage || undefined}>
            <Button size="sm" variant="outline" onClick={() => void refreshCompatibility(opencodeClient.getDirectory() ?? undefined)} disabled={saving}>{t('settings.workspaces.compatibility.recheck')}</Button>
            <Button size="sm" onClick={() => void activateWorkspaces()} disabled={saving || !settings.secureWorkspacesEnabled}>{t('settings.workspaces.compatibility.activate')}</Button>
          </SettingsFieldRow>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.workspaces.title')} settingsItem="workspaces.providers">
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsStackedField label={t('settings.workspaces.image')} settingsItem="workspaces.image">
            <Input className="h-8" value={settings.secureWorkspacesImage} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesImage: event.target.value }))} onBlur={() => void save({ secureWorkspacesImage: settings.secureWorkspacesImage.trim() })} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.workspaces.allowedImages')} info={t('settings.workspaces.allowedImagesHint')}>
            <Input className="h-8" value={settings.secureWorkspacesAllowedImages} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesAllowedImages: event.target.value }))} onBlur={() => void save({ secureWorkspacesAllowedImages: settings.secureWorkspacesAllowedImages.trim() })} />
          </SettingsStackedField>
          {(['docker', 'apple-container', 'kubernetes'] as const).map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              selected={settings.secureWorkspacesDefaultProvider === provider}
              status={providerStatus[provider]}
              error={providerErrors[provider]}
              validating={validating === provider}
              onSelect={() => void save({ secureWorkspacesDefaultProvider: provider })}
              onValidate={() => void validate(provider)}
            />
          ))}
          {settings.secureWorkspacesDefaultProvider === 'kubernetes' && (
            <div className={SETTINGS_FIELDS_STACK_CLASS}>
            <SettingsTwoColumn>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.context')} settingsItem="workspaces.kubernetes">
                <Input className="h-8" value={settings.secureWorkspacesKubernetesContext} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesContext: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesContext: settings.secureWorkspacesKubernetesContext.trim() })} />
              </SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.namespace')}>
                <Input className="h-8" value={settings.secureWorkspacesKubernetesNamespace} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesNamespace: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesNamespace: settings.secureWorkspacesKubernetesNamespace.trim() || DEFAULT_NAMESPACE })} />
              </SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.storage')}><Input className="h-8" value={settings.secureWorkspacesKubernetesStorage} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesStorage: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesStorage: settings.secureWorkspacesKubernetesStorage.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.cpuRequest')}><Input className="h-8" value={settings.secureWorkspacesKubernetesCpuRequest} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesCpuRequest: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesCpuRequest: settings.secureWorkspacesKubernetesCpuRequest.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.memoryRequest')}><Input className="h-8" value={settings.secureWorkspacesKubernetesMemoryRequest} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesMemoryRequest: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesMemoryRequest: settings.secureWorkspacesKubernetesMemoryRequest.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.cpuLimit')}><Input className="h-8" value={settings.secureWorkspacesKubernetesCpuLimit} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesCpuLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesCpuLimit: settings.secureWorkspacesKubernetesCpuLimit.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.memoryLimit')}><Input className="h-8" value={settings.secureWorkspacesKubernetesMemoryLimit} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesMemoryLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesMemoryLimit: settings.secureWorkspacesKubernetesMemoryLimit.trim() })} /></SettingsStackedField>
            </SettingsTwoColumn>
            <SettingsFieldRow label={t('settings.workspaces.kubernetes.connectivity')}><Button size="sm" variant={settings.secureWorkspacesKubernetesConnectivity === 'port-forward' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesKubernetesConnectivity: 'port-forward' })}>{t('settings.workspaces.kubernetes.portForward')}</Button><Button size="sm" variant={settings.secureWorkspacesKubernetesConnectivity === 'ingress' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesKubernetesConnectivity: 'ingress' })}>{t('settings.workspaces.kubernetes.ingress')}</Button></SettingsFieldRow>
            {settings.secureWorkspacesKubernetesConnectivity === 'ingress' && <SettingsTwoColumn>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.ingressClass')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressClassName} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressClassName: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressClassName: settings.secureWorkspacesKubernetesIngressClassName.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.hostTemplate')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressHostTemplate} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressHostTemplate: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressHostTemplate: settings.secureWorkspacesKubernetesIngressHostTemplate.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.pathTemplate')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressPathTemplate} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressPathTemplate: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressPathTemplate: settings.secureWorkspacesKubernetesIngressPathTemplate.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.namespaceSelector')}><Input className="h-8 font-mono" value={settings.secureWorkspacesKubernetesIngressNamespaceSelector} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressNamespaceSelector: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressNamespaceSelector: settings.secureWorkspacesKubernetesIngressNamespaceSelector.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.podSelector')}><Input className="h-8 font-mono" value={settings.secureWorkspacesKubernetesIngressPodSelector} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressPodSelector: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressPodSelector: settings.secureWorkspacesKubernetesIngressPodSelector.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.annotations')}><Input className="h-8 font-mono" value={settings.secureWorkspacesKubernetesIngressAnnotations} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressAnnotations: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressAnnotations: settings.secureWorkspacesKubernetesIngressAnnotations.trim() })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.workspaces.kubernetes.tlsMode')}><div className="flex flex-wrap gap-1.5"><Button size="sm" variant={settings.secureWorkspacesKubernetesIngressTlsMode === 'existing-secret' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesKubernetesIngressTlsMode: 'existing-secret' })}>{t('settings.workspaces.kubernetes.existingSecret')}</Button><Button size="sm" variant={settings.secureWorkspacesKubernetesIngressTlsMode === 'cert-manager' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesKubernetesIngressTlsMode: 'cert-manager' })}>{t('settings.workspaces.kubernetes.certManager')}</Button></div></SettingsStackedField>
              {settings.secureWorkspacesKubernetesIngressTlsMode === 'existing-secret' ? <SettingsStackedField label={t('settings.workspaces.kubernetes.tlsSecret')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressTlsSecretName} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressTlsSecretName: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressTlsSecretName: settings.secureWorkspacesKubernetesIngressTlsSecretName.trim() })} /></SettingsStackedField> : <SettingsStackedField label={t('settings.workspaces.kubernetes.clusterIssuer')}><Input className="h-8" value={settings.secureWorkspacesKubernetesIngressClusterIssuer} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesIngressClusterIssuer: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesIngressClusterIssuer: settings.secureWorkspacesKubernetesIngressClusterIssuer.trim() })} /></SettingsStackedField>}
            </SettingsTwoColumn>}
            </div>
          )}
          {settings.secureWorkspacesDefaultProvider === 'docker' && <SettingsTwoColumn><SettingsStackedField label={t('settings.workspaces.docker.memory')}><Input className="h-8" value={settings.secureWorkspacesDockerMemoryLimit} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesDockerMemoryLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesDockerMemoryLimit: settings.secureWorkspacesDockerMemoryLimit.trim() })} /></SettingsStackedField><SettingsStackedField label={t('settings.workspaces.docker.cpu')}><Input className="h-8" value={settings.secureWorkspacesDockerCpuLimit} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesDockerCpuLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesDockerCpuLimit: settings.secureWorkspacesDockerCpuLimit.trim() })} /></SettingsStackedField><SettingsStackedField label={t('settings.workspaces.docker.pids')}><Input className="h-8" type="number" min={1} value={settings.secureWorkspacesDockerPidsLimit} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesDockerPidsLimit: Number(event.target.value) }))} onBlur={() => void save({ secureWorkspacesDockerPidsLimit: settings.secureWorkspacesDockerPidsLimit })} /></SettingsStackedField></SettingsTwoColumn>}
          {settings.secureWorkspacesDefaultProvider === 'apple-container' && <SettingsTwoColumn><SettingsStackedField label={t('settings.workspaces.apple.memory')}><Input className="h-8" value={settings.secureWorkspacesAppleMemoryLimit} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesAppleMemoryLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesAppleMemoryLimit: settings.secureWorkspacesAppleMemoryLimit.trim() })} /></SettingsStackedField><SettingsStackedField label={t('settings.workspaces.apple.cpu')}><Input className="h-8" value={settings.secureWorkspacesAppleCpuLimit} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesAppleCpuLimit: event.target.value }))} onBlur={() => void save({ secureWorkspacesAppleCpuLimit: settings.secureWorkspacesAppleCpuLimit.trim() })} /></SettingsStackedField></SettingsTwoColumn>}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.workspaces.egress.title')} info={t('settings.workspaces.egress.description')} settingsItem="workspaces.egress">
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsFieldRow label={t('settings.workspaces.egress.mode')}><Button size="sm" variant={settings.secureWorkspacesEgressMode === 'managed' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesEgressMode: 'managed' })}>{t('settings.workspaces.egress.managed')}</Button><Button size="sm" variant={settings.secureWorkspacesEgressMode === 'external' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesEgressMode: 'external' })}>{t('settings.workspaces.egress.external')}</Button></SettingsFieldRow>
        <SettingsTwoColumn>
          {settings.secureWorkspacesEgressMode === 'managed' ? <>
          <SettingsStackedField label={t('settings.workspaces.egress.gatewayImage')}><Input className="h-8" value={settings.secureWorkspacesGatewayImage} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesGatewayImage: event.target.value }))} onBlur={() => void save({ secureWorkspacesGatewayImage: settings.secureWorkspacesGatewayImage.trim() })} /></SettingsStackedField>
          <SettingsStackedField label={t('settings.workspaces.egress.preset')}><div className="flex flex-wrap gap-1.5"><Button size="sm" variant={settings.secureWorkspacesEgressPreset === 'restricted' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesEgressPreset: 'restricted' })}>{t('settings.workspaces.egress.restricted')}</Button><Button size="sm" variant={settings.secureWorkspacesEgressPreset === 'custom' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesEgressPreset: 'custom' })}>{t('settings.workspaces.egress.custom')}</Button></div></SettingsStackedField>
          <SettingsStackedField label={t('settings.workspaces.egress.allowedDomains')}><Input className="h-8" value={settings.secureWorkspacesEgressAllowedDomains} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressAllowedDomains: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressAllowedDomains: settings.secureWorkspacesEgressAllowedDomains.trim() })} /></SettingsStackedField>
          <SettingsStackedField label={t('settings.workspaces.egress.allowedCIDRs')}><Input className="h-8" value={settings.secureWorkspacesEgressAllowedCIDRs} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressAllowedCIDRs: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressAllowedCIDRs: settings.secureWorkspacesEgressAllowedCIDRs.trim() })} /></SettingsStackedField>
          <SettingsStackedField label={t('settings.workspaces.egress.allowedPorts')}><Input className="h-8" value={settings.secureWorkspacesEgressAllowedPorts} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressAllowedPorts: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressAllowedPorts: settings.secureWorkspacesEgressAllowedPorts.trim() })} /></SettingsStackedField>
          </> : <>
          <SettingsStackedField label={t('settings.workspaces.egress.httpProxy')}><Input className="h-8" value={settings.secureWorkspacesEgressProxyUrl} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressProxyUrl: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressProxyUrl: settings.secureWorkspacesEgressProxyUrl.trim() })} /></SettingsStackedField>
          <SettingsStackedField label={t('settings.workspaces.egress.proxyCIDR')}><Input className="h-8" value={settings.secureWorkspacesEgressProxyCIDR} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressProxyCIDR: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressProxyCIDR: settings.secureWorkspacesEgressProxyCIDR.trim() })} /></SettingsStackedField>
          </>}
          <SettingsStackedField label={t('settings.workspaces.egress.noProxy')}><Input className="h-8" value={settings.secureWorkspacesEgressNoProxy} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressNoProxy: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressNoProxy: settings.secureWorkspacesEgressNoProxy.trim() || DEFAULT_NO_PROXY })} /></SettingsStackedField>
          <SettingsStackedField label={t('settings.workspaces.egress.dnsCIDRs')}><Input className="h-8" value={settings.secureWorkspacesEgressDnsCIDRs} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressDnsCIDRs: event.target.value }))} onBlur={() => void save({ secureWorkspacesEgressDnsCIDRs: settings.secureWorkspacesEgressDnsCIDRs.trim() })} /></SettingsStackedField>
        </SettingsTwoColumn>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.workspaces.policy.title')} settingsItem="workspaces.policy">
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsFieldRow label={t('settings.workspaces.credentials.modelAuth')} info={t('settings.workspaces.credentials.modelAuthHint')}><Button size="sm" variant={settings.secureWorkspacesModelAuth === 'none' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesModelAuth: 'none' })}>{t('settings.workspaces.credentials.none')}</Button><Button size="sm" variant={settings.secureWorkspacesModelAuth === 'explicit-opencode-auth-content' ? 'chip' : 'ghost'} onClick={() => void save({ secureWorkspacesModelAuth: 'explicit-opencode-auth-content' })}>{t('settings.workspaces.credentials.explicit')}</Button></SettingsFieldRow>
          <SettingsCheckboxRow checked={settings.secureWorkspacesRetentionPreserveOnDelete} onChange={(checked) => void save({ secureWorkspacesRetentionPreserveOnDelete: checked })} label={t('settings.workspaces.retention.preserve')} ariaLabel={t('settings.workspaces.retention.preserve')} description={settings.secureWorkspacesRetentionPreserveOnDelete ? t('settings.workspaces.retention.warning') : undefined} />
        </div>
      </SettingsSection>

    </SettingsPageLayout>
    <Dialog open={reauthRequest !== null} onOpenChange={(open) => { if (!open) cancelReauthentication(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.workspaces.reauth.title')}</DialogTitle>
          <DialogDescription>{t('settings.workspaces.reauth.prompt')}</DialogDescription>
        </DialogHeader>
        <Input
          type="password"
          autoComplete="current-password"
          value={reauthPassword}
          onChange={(event) => setReauthPassword(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void confirmReauthentication(); }}
          placeholder={t('sessionAuth.password.placeholder')}
          aria-label={t('sessionAuth.password.placeholder')}
          disabled={reauthBusy}
          autoFocus
        />
        {reauthError && <p className="typography-meta text-[var(--status-error)]" role="alert">{reauthError}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={cancelReauthentication} disabled={reauthBusy}>{t('settings.common.actions.cancel')}</Button>
          <Button size="sm" onClick={() => void confirmReauthentication()} disabled={reauthBusy}>{t('settings.workspaces.reauth.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
};

function ProviderRow({ provider, selected, status, error, validating, onSelect, onValidate }: {
  provider: WorkspaceProviderKind;
  selected: boolean;
  status?: WorkspaceProviderValidationResult;
  error?: string;
  validating: boolean;
  onSelect: () => void;
  onValidate: () => void;
}) {
  const { t } = useI18n();
  const title = provider === 'apple-container' ? t('settings.workspaces.provider.appleContainer') : provider === 'kubernetes' ? t('settings.workspaces.provider.kubernetes') : t('settings.workspaces.provider.docker');
  const hint = provider === 'apple-container' ? t('settings.workspaces.provider.appleContainerHint') : provider === 'kubernetes' ? t('settings.workspaces.provider.kubernetesHint') : t('settings.workspaces.provider.dockerHint');
  return (
    <SettingsFieldRow label={title} info={hint} controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}>
      <span className={cn('typography-meta', error || status?.available === false ? 'text-[var(--status-error)]' : status?.available ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>{error || status?.error || (status ? status.available ? t('settings.workspaces.status.available') : t('settings.workspaces.status.unavailable') : t('settings.workspaces.status.notChecked'))}</span>
      <Button size="sm" variant={selected ? 'chip' : 'ghost'} aria-pressed={selected} onClick={onSelect}>{selected ? t('settings.workspaces.default') : t('settings.workspaces.actions.use')}</Button>
      <Button size="sm" variant="outline" onClick={onValidate} disabled={validating}>{validating ? t('settings.workspaces.actions.validating') : t('settings.workspaces.actions.validate')}</Button>
    </SettingsFieldRow>
  );
}
