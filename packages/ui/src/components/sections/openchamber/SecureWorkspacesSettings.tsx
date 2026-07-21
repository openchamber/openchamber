import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import type { WorkspaceCompatibilityResult, WorkspacePatchSummary, WorkspaceProviderKind, WorkspaceProviderValidationResult } from '@/lib/api/types';

type SecureWorkspaceSettingsPayload = {
  secureWorkspacesEnabled?: boolean;
  secureWorkspacesDefaultProvider?: WorkspaceProviderKind;
  secureWorkspacesImage?: string;
  secureWorkspacesKubernetesContext?: string;
  secureWorkspacesKubernetesNamespace?: string;
  secureWorkspacesRequirePinnedImage?: boolean;
  secureWorkspacesEgressHttpProxy?: string;
  secureWorkspacesEgressProxyCIDR?: string;
  secureWorkspacesEgressDnsCIDRs?: string;
  secureWorkspacesEgressNoProxy?: string;
};

type WorkspaceListItem = {
  id: string;
  type: string;
  name: string;
  directory?: string | null;
  status?: string | null;
};

const DEFAULT_IMAGE = 'ghcr.io/openchamber/opencode-workspace:1.0.0';

export const SecureWorkspacesSettings: React.FC = () => {
  const { t } = useI18n();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState(false);
  const [validating, setValidating] = React.useState<WorkspaceProviderKind | null>(null);
  const [exportBusy, setExportBusy] = React.useState(false);
  const [applyBusy, setApplyBusy] = React.useState(false);
  const [status, setStatus] = React.useState<Partial<Record<WorkspaceProviderKind, WorkspaceProviderValidationResult>>>({});
  const [compatibility, setCompatibility] = React.useState<WorkspaceCompatibilityResult | null>(null);
  const [activationMessage, setActivationMessage] = React.useState('');
  const [workspaceList, setWorkspaceList] = React.useState<WorkspaceListItem[]>([]);
  const [selectedWorkspaceID, setSelectedWorkspaceID] = React.useState('');
  const [workspaceActionMessage, setWorkspaceActionMessage] = React.useState('');
  const [warpSessionID, setWarpSessionID] = React.useState('');
  const [targetDirectory, setTargetDirectory] = React.useState(() => opencodeClient.getDirectory() ?? '');
  const [patch, setPatch] = React.useState('');
  const [exportID, setExportID] = React.useState('');
  const [exportExpiresAt, setExportExpiresAt] = React.useState('');
  const [selectedFileIDs, setSelectedFileIDs] = React.useState<string[]>([]);
  const [patchSummary, setPatchSummary] = React.useState<WorkspacePatchSummary | null>(null);
  const [exportError, setExportError] = React.useState('');
  const [applyMessage, setApplyMessage] = React.useState('');
  const [settings, setSettings] = React.useState<Required<SecureWorkspaceSettingsPayload>>({
    secureWorkspacesEnabled: false,
    secureWorkspacesDefaultProvider: 'docker',
    secureWorkspacesImage: DEFAULT_IMAGE,
    secureWorkspacesKubernetesContext: '',
    secureWorkspacesKubernetesNamespace: 'openchamber-workspaces',
    secureWorkspacesRequirePinnedImage: true,
    secureWorkspacesEgressHttpProxy: '',
    secureWorkspacesEgressProxyCIDR: '',
    secureWorkspacesEgressDnsCIDRs: '',
    secureWorkspacesEgressNoProxy: '127.0.0.1,localhost',
  });

  const refreshCompatibility = React.useCallback(async (directory?: string | null) => {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces) {
      setCompatibility({ configured: false, active: false, supported: false, adapterKinds: [], status: 'not-configured', error: t('settings.workspaces.status.unsupported') });
      return;
    }
    try {
      setCompatibility(await workspaces.compatibility({ directory: directory || undefined }));
    } catch (error) {
      setCompatibility({
        configured: false,
        active: false,
        supported: false,
        adapterKinds: [],
        status: 'not-configured',
        error: error instanceof Error ? error.message : t('settings.workspaces.compatibility.failed'),
      });
    }
  }, [t]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        const result = await runtimeSettings?.load();
        const loaded = (result?.settings ?? {}) as SecureWorkspaceSettingsPayload;
        if (cancelled) return;
        setSettings((current) => ({
          ...current,
          secureWorkspacesEnabled: loaded.secureWorkspacesEnabled === true,
          secureWorkspacesDefaultProvider: loaded.secureWorkspacesDefaultProvider === 'kubernetes'
            ? 'kubernetes'
            : loaded.secureWorkspacesDefaultProvider === 'apple-container'
              ? 'apple-container'
              : 'docker',
          secureWorkspacesImage: typeof loaded.secureWorkspacesImage === 'string' && loaded.secureWorkspacesImage.trim()
            ? loaded.secureWorkspacesImage.trim()
            : DEFAULT_IMAGE,
          secureWorkspacesKubernetesContext: typeof loaded.secureWorkspacesKubernetesContext === 'string'
            ? loaded.secureWorkspacesKubernetesContext
            : '',
          secureWorkspacesKubernetesNamespace: typeof loaded.secureWorkspacesKubernetesNamespace === 'string' && loaded.secureWorkspacesKubernetesNamespace.trim()
            ? loaded.secureWorkspacesKubernetesNamespace.trim()
            : 'openchamber-workspaces',
          secureWorkspacesRequirePinnedImage: loaded.secureWorkspacesRequirePinnedImage !== false,
          secureWorkspacesEgressHttpProxy: typeof loaded.secureWorkspacesEgressHttpProxy === 'string'
            ? loaded.secureWorkspacesEgressHttpProxy
            : '',
          secureWorkspacesEgressProxyCIDR: typeof loaded.secureWorkspacesEgressProxyCIDR === 'string'
            ? loaded.secureWorkspacesEgressProxyCIDR
            : '',
          secureWorkspacesEgressDnsCIDRs: typeof loaded.secureWorkspacesEgressDnsCIDRs === 'string'
            ? loaded.secureWorkspacesEgressDnsCIDRs
            : '',
          secureWorkspacesEgressNoProxy: typeof loaded.secureWorkspacesEgressNoProxy === 'string'
            ? loaded.secureWorkspacesEgressNoProxy
            : '127.0.0.1,localhost',
        }));
        await refreshCompatibility(opencodeClient.getDirectory() ?? '');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshCompatibility]);

  async function save(changes: Partial<SecureWorkspaceSettingsPayload>) {
    const previous = settings;
    setSettings((current) => ({ ...current, ...changes }));
    setSaveError(false);
    setSaving(true);
    try {
      await getRegisteredRuntimeAPIs()?.settings.save(changes);
      const configured = await getRegisteredRuntimeAPIs()?.workspaces?.configureFromSettings({ activate: false });
      if (configured?.compatibility) setCompatibility(configured.compatibility);
    } catch {
      setSettings(previous);
      await getRegisteredRuntimeAPIs()?.settings.save(previous).catch(() => undefined);
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  function clearExportArtifact() {
    setPatch('');
    setExportID('');
    setExportExpiresAt('');
    setSelectedFileIDs([]);
    setPatchSummary(null);
    setApplyMessage('');
  }

  function updateTargetDirectory(value: string) {
    setTargetDirectory(value);
    clearExportArtifact();
  }

  function selectWorkspace(id: string) {
    if (selectedWorkspaceID !== id) clearExportArtifact();
    setSelectedWorkspaceID(id);
  }

  async function activateWorkspaces() {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces) return;
    setSaving(true);
    setSaveError(false);
    setActivationMessage('');
    try {
      const result = await workspaces.configureFromSettings({ activate: true });
      if (result.compatibility) setCompatibility(result.compatibility);
      if (result.manualRestartRequired) {
        setActivationMessage(t('settings.workspaces.compatibility.manualRestart'));
      } else if (result.active || result.compatibility?.active) {
        setActivationMessage(t('settings.workspaces.compatibility.activated'));
      } else {
        setActivationMessage(t('settings.workspaces.compatibility.pending'));
      }
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  async function validate(provider: WorkspaceProviderKind) {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces) {
      setStatus((current) => ({ ...current, [provider]: { available: false, error: t('settings.workspaces.status.unsupported') } }));
      return;
    }
    setValidating(provider);
    try {
    const result = await workspaces.validateProvider({
        provider,
        context: provider === 'kubernetes' ? settings.secureWorkspacesKubernetesContext : undefined,
        namespace: provider === 'kubernetes' ? settings.secureWorkspacesKubernetesNamespace : undefined,
        egressHttpProxy: settings.secureWorkspacesEgressHttpProxy,
        egressProxyCIDR: settings.secureWorkspacesEgressProxyCIDR,
        egressDnsCIDRs: settings.secureWorkspacesEgressDnsCIDRs,
        egressNoProxy: settings.secureWorkspacesEgressNoProxy,
      });
      setStatus((current) => ({ ...current, [provider]: result }));
    } finally {
      setValidating(null);
    }
  }

  async function applyEgressSettings() {
    await save({
      secureWorkspacesEgressHttpProxy: settings.secureWorkspacesEgressHttpProxy.trim(),
      secureWorkspacesEgressProxyCIDR: settings.secureWorkspacesEgressProxyCIDR.trim(),
      secureWorkspacesEgressDnsCIDRs: settings.secureWorkspacesEgressDnsCIDRs.trim(),
      secureWorkspacesEgressNoProxy: settings.secureWorkspacesEgressNoProxy.trim() || '127.0.0.1,localhost',
    });
  }

  async function loadWorkspaces() {
    setExportBusy(true);
    setExportError('');
    setWorkspaceActionMessage('');
    try {
      await opencodeClient.experimentalWorkspaces.syncList(targetDirectory || undefined).catch(() => undefined);
      const list = await opencodeClient.experimentalWorkspaces.list(targetDirectory || undefined);
      const statuses = await opencodeClient.experimentalWorkspaces.status(targetDirectory || undefined).catch(() => []);
      const statusByID = new Map(statuses.map((item) => [item.workspaceID, item.status]));
      setWorkspaceList(list.map((item) => ({ id: item.id, type: item.type, name: item.name, directory: item.directory, status: statusByID.get(item.id) ?? null })));
      const nextSelectedWorkspaceID = selectedWorkspaceID && list.some((item) => item.id === selectedWorkspaceID)
        ? selectedWorkspaceID
        : list[0]?.id || '';
      if (nextSelectedWorkspaceID !== selectedWorkspaceID) {
        clearExportArtifact();
      }
      setSelectedWorkspaceID(nextSelectedWorkspaceID);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setExportBusy(false);
    }
  }

  async function createWorkspace() {
    setExportBusy(true);
    setExportError('');
    setWorkspaceActionMessage('');
    try {
      const created = await opencodeClient.experimentalWorkspaces.create({
        type: settings.secureWorkspacesDefaultProvider,
        directory: targetDirectory || undefined,
        extra: { image: settings.secureWorkspacesImage },
      });
      setSelectedWorkspaceID(created.id);
      clearExportArtifact();
      setWorkspaceActionMessage(t('settings.workspaces.lifecycle.created'));
      await loadWorkspaces();
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.createFailed'));
    } finally {
      setExportBusy(false);
    }
  }

  async function deleteWorkspace() {
    if (!selectedWorkspaceID) return;
    if (!window.confirm(t('settings.workspaces.lifecycle.confirmDelete'))) return;
    setExportBusy(true);
    setExportError('');
    setWorkspaceActionMessage('');
    try {
      await opencodeClient.experimentalWorkspaces.remove(selectedWorkspaceID, targetDirectory || undefined);
      setSelectedWorkspaceID('');
      clearExportArtifact();
      setWorkspaceActionMessage(t('settings.workspaces.lifecycle.deleted'));
      await loadWorkspaces();
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.deleteFailed'));
    } finally {
      setExportBusy(false);
    }
  }

  async function warpSession() {
    if (!selectedWorkspaceID || !warpSessionID.trim()) return;
    setExportBusy(true);
    setExportError('');
    setWorkspaceActionMessage('');
    try {
      await opencodeClient.experimentalWorkspaces.warp({
        id: selectedWorkspaceID,
        sessionID: warpSessionID.trim(),
        copyChanges: false,
        directory: targetDirectory || undefined,
      });
      setWorkspaceActionMessage(t('settings.workspaces.lifecycle.warped'));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.warpFailed'));
    } finally {
      setExportBusy(false);
    }
  }

  async function exportSelectedWorkspace() {
    if (!selectedWorkspaceID) return;
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces) return;
    setExportBusy(true);
    setExportError('');
    setApplyMessage('');
    try {
      const exported = await workspaces.exportDiff({ id: selectedWorkspaceID, directory: targetDirectory || undefined });
      setPatch(exported.patch);
      setExportID(exported.exportID ?? '');
      setExportExpiresAt(exported.expiresAt ?? '');
      const summary = exported.summary ? { summary: exported.summary, patchBytes: exported.patchBytes ?? 0 } : await workspaces.summarizePatch(exported.patch);
      setPatchSummary(summary.summary);
      setSelectedFileIDs(summary.summary.files.map((file) => file.id).filter((id): id is string => Boolean(id)));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setExportBusy(false);
    }
  }

  async function checkPatch() {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces || !patch || !targetDirectory) return;
    setApplyBusy(true);
    setApplyMessage('');
    try {
      const result = exportID
        ? await workspaces.applyPatch({ directory: targetDirectory, exportID, fileIDs: selectedFileIDs, workspaceID: selectedWorkspaceID, checkOnly: true })
        : await workspaces.applyPatch({ directory: targetDirectory, patch, checkOnly: true });
      setApplyMessage(result.error || t('settings.workspaces.export.checkPassed'));
    } finally {
      setApplyBusy(false);
    }
  }

  async function applyPatch() {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces || !patch || !targetDirectory) return;
    if (!window.confirm(t('settings.workspaces.export.confirmApply'))) return;
    setApplyBusy(true);
    setApplyMessage('');
    try {
      const result = exportID
        ? await workspaces.applyPatch({ directory: targetDirectory, exportID, fileIDs: selectedFileIDs, workspaceID: selectedWorkspaceID, checkOnly: false })
        : await workspaces.applyPatch({ directory: targetDirectory, patch, checkOnly: false });
      setApplyMessage(result.error || t('settings.workspaces.export.applied'));
    } finally {
      setApplyBusy(false);
    }
  }

  if (loading) return null;

  const canApplyEgress = settings.secureWorkspacesEgressHttpProxy.trim().length > 0
    && (settings.secureWorkspacesDefaultProvider === 'docker'
      || settings.secureWorkspacesDefaultProvider === 'apple-container'
      || (settings.secureWorkspacesEgressProxyCIDR.trim().length > 0 && settings.secureWorkspacesEgressDnsCIDRs.trim().length > 0));
  const selectedFileCount = selectedFileIDs.length;
  const selectableFiles = patchSummary?.files.filter((file) => file.id) ?? [];
  const compatibilityText = compatibility
    ? compatibility.active
      ? t('settings.workspaces.compatibility.active')
      : compatibility.configured
        ? compatibility.supported
          ? t('settings.workspaces.compatibility.configuredInactive')
          : t('settings.workspaces.compatibility.unsupported')
        : t('settings.workspaces.compatibility.notConfigured')
    : t('settings.workspaces.status.notChecked');

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.workspaces.title')}</h3>
        <p className="typography-meta text-muted-foreground">{t('settings.workspaces.description')}</p>
      </div>

      <section className="space-y-3 px-2 pb-2 pt-1">
        <div data-settings-item="workspaces.enable" className="flex items-center gap-2 py-1.5">
          <Checkbox
            checked={settings.secureWorkspacesEnabled}
            onChange={(checked) => void save({ secureWorkspacesEnabled: checked })}
            ariaLabel={t('settings.workspaces.enable')}
          />
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground">{t('settings.workspaces.enable')}</div>
            <div className="typography-meta text-muted-foreground">{t('settings.workspaces.enableHint')}</div>
          </div>
        </div>

        <div data-settings-item="workspaces.compatibility" className="space-y-2 py-1.5">
          <div className="typography-ui-label text-foreground">{t('settings.workspaces.compatibility.title')}</div>
          <div className="typography-meta text-muted-foreground">{compatibilityText}</div>
          {compatibility?.error && <div className="typography-meta text-[var(--status-error)]">{compatibility.error}</div>}
          {activationMessage && <div className="typography-meta text-muted-foreground">{activationMessage}</div>}
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => void refreshCompatibility(targetDirectory)} disabled={saving}>{t('settings.workspaces.compatibility.recheck')}</Button>
            <Button size="xs" variant="default" onClick={() => void activateWorkspaces()} disabled={saving || !settings.secureWorkspacesEnabled}>{t('settings.workspaces.compatibility.activate')}</Button>
          </div>
        </div>

        <div data-settings-item="workspaces.image" className="space-y-1 py-1.5">
          <label className="typography-ui-label text-foreground" htmlFor="secure-workspaces-image">{t('settings.workspaces.image')}</label>
          <Input
            id="secure-workspaces-image"
            className="h-8"
            value={settings.secureWorkspacesImage}
            onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesImage: event.target.value }))}
            onBlur={() => void save({ secureWorkspacesImage: settings.secureWorkspacesImage.trim() || DEFAULT_IMAGE })}
          />
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              checked={settings.secureWorkspacesRequirePinnedImage}
              onChange={(checked) => void save({ secureWorkspacesRequirePinnedImage: checked })}
              ariaLabel={t('settings.workspaces.requirePinnedImage')}
            />
            <span className="typography-meta text-muted-foreground">{t('settings.workspaces.requirePinnedImage')}</span>
          </div>
        </div>

        <div data-settings-item="workspaces.providers" className="grid gap-3 md:grid-cols-3">
          <ProviderCard
            provider="docker"
            title={t('settings.workspaces.provider.docker')}
            description={t('settings.workspaces.provider.dockerHint')}
            selected={settings.secureWorkspacesDefaultProvider === 'docker'}
            status={status.docker}
            validating={validating === 'docker'}
            onSelect={() => void save({ secureWorkspacesDefaultProvider: 'docker' })}
            onValidate={() => void validate('docker')}
            validateLabel={t('settings.workspaces.actions.validate')}
            selectedLabel={t('settings.workspaces.default')}
          />
          <ProviderCard
            provider="apple-container"
            title={t('settings.workspaces.provider.appleContainer')}
            description={t('settings.workspaces.provider.appleContainerHint')}
            selected={settings.secureWorkspacesDefaultProvider === 'apple-container'}
            status={status['apple-container']}
            validating={validating === 'apple-container'}
            onSelect={() => void save({ secureWorkspacesDefaultProvider: 'apple-container' })}
            onValidate={() => void validate('apple-container')}
            validateLabel={t('settings.workspaces.actions.validate')}
            selectedLabel={t('settings.workspaces.default')}
          />
          <ProviderCard
            provider="kubernetes"
            title={t('settings.workspaces.provider.kubernetes')}
            description={t('settings.workspaces.provider.kubernetesHint')}
            selected={settings.secureWorkspacesDefaultProvider === 'kubernetes'}
            status={status.kubernetes}
            validating={validating === 'kubernetes'}
            onSelect={() => void save({ secureWorkspacesDefaultProvider: 'kubernetes' })}
            onValidate={() => void validate('kubernetes')}
            validateLabel={t('settings.workspaces.actions.validate')}
            selectedLabel={t('settings.workspaces.default')}
          />
        </div>

        <div data-settings-item="workspaces.kubernetes" className="grid gap-2 py-1.5 md:grid-cols-2">
          <label className="space-y-1">
            <span className="typography-ui-label text-foreground">{t('settings.workspaces.kubernetes.context')}</span>
            <Input className="h-8" value={settings.secureWorkspacesKubernetesContext} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesContext: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesContext: settings.secureWorkspacesKubernetesContext.trim() })} />
          </label>
          <label className="space-y-1">
            <span className="typography-ui-label text-foreground">{t('settings.workspaces.kubernetes.namespace')}</span>
            <Input className="h-8" value={settings.secureWorkspacesKubernetesNamespace} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesNamespace: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesNamespace: settings.secureWorkspacesKubernetesNamespace.trim() || 'openchamber-workspaces' })} />
          </label>
        </div>

        <div data-settings-item="workspaces.egress" className="space-y-2 py-1.5">
          <div>
            <div className="typography-ui-label text-foreground">{t('settings.workspaces.egress.title')}</div>
            <div className="typography-meta text-muted-foreground">{t('settings.workspaces.egress.description')}</div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="space-y-1">
              <span className="typography-ui-label text-foreground">{t('settings.workspaces.egress.httpProxy')}</span>
              <Input className="h-8" value={settings.secureWorkspacesEgressHttpProxy} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressHttpProxy: event.target.value }))} />
            </label>
            <label className="space-y-1">
              <span className="typography-ui-label text-foreground">{t('settings.workspaces.egress.noProxy')}</span>
              <Input className="h-8" value={settings.secureWorkspacesEgressNoProxy} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressNoProxy: event.target.value }))} />
            </label>
            <label className="space-y-1">
              <span className="typography-ui-label text-foreground">{t('settings.workspaces.egress.proxyCIDR')}</span>
              <Input className="h-8" value={settings.secureWorkspacesEgressProxyCIDR} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressProxyCIDR: event.target.value }))} />
            </label>
            <label className="space-y-1">
              <span className="typography-ui-label text-foreground">{t('settings.workspaces.egress.dnsCIDRs')}</span>
              <Input className="h-8" value={settings.secureWorkspacesEgressDnsCIDRs} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesEgressDnsCIDRs: event.target.value }))} />
            </label>
          </div>
          <Button size="xs" variant="outline" onClick={() => void applyEgressSettings()} disabled={saving || !canApplyEgress}>{t('settings.workspaces.egress.apply')}</Button>
        </div>

        <div data-settings-item="workspaces.export" className="space-y-2 py-1.5">
          <div>
            <div className="typography-ui-label text-foreground">{t('settings.workspaces.lifecycle.title')}</div>
            <div className="typography-meta text-muted-foreground">{t('settings.workspaces.lifecycle.description')}</div>
          </div>
          <label className="space-y-1">
            <span className="typography-meta text-muted-foreground">{t('settings.workspaces.export.directory')}</span>
            <Input className="h-8" value={targetDirectory} onChange={(event) => updateTargetDirectory(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => void loadWorkspaces()} disabled={exportBusy}>{t('settings.workspaces.export.load')}</Button>
            <Button size="xs" variant="default" onClick={() => void createWorkspace()} disabled={exportBusy || !settings.secureWorkspacesEnabled}>{t('settings.workspaces.lifecycle.create')}</Button>
            <Button size="xs" variant="destructive" onClick={() => void deleteWorkspace()} disabled={exportBusy || !selectedWorkspaceID}>{t('settings.workspaces.lifecycle.delete')}</Button>
          </div>
          {workspaceList.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {workspaceList.map((workspace) => (
                <Button key={workspace.id} size="xs" variant="chip" aria-pressed={workspace.id === selectedWorkspaceID} onClick={() => selectWorkspace(workspace.id)}>
                  {workspace.name || workspace.id}{workspace.status ? ` · ${workspace.status}` : ''}
                </Button>
              ))}
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
            <Input className="h-8" value={warpSessionID} onChange={(event) => setWarpSessionID(event.target.value)} placeholder={t('settings.workspaces.lifecycle.sessionPlaceholder')} />
            <Button size="xs" variant="outline" onClick={() => void warpSession()} disabled={exportBusy || !selectedWorkspaceID || !warpSessionID.trim()}>{t('settings.workspaces.lifecycle.warp')}</Button>
          </div>
          {workspaceActionMessage && <div className="typography-meta text-muted-foreground">{workspaceActionMessage}</div>}

          <div className="pt-2">
            <div className="typography-ui-label text-foreground">{t('settings.workspaces.export.title')}</div>
            <div className="typography-meta text-muted-foreground">{t('settings.workspaces.export.description')}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="default" onClick={() => void exportSelectedWorkspace()} disabled={exportBusy || !selectedWorkspaceID}>{t('settings.workspaces.export.review')}</Button>
          </div>
          {patchSummary && (
            <div className="space-y-2">
              <div className="typography-meta text-muted-foreground">
                {t('settings.workspaces.export.summary', {
                  files: String(patchSummary.totalFiles),
                  additions: String(patchSummary.additions),
                  deletions: String(patchSummary.deletions),
                })}
              </div>
              {exportExpiresAt && <div className="typography-meta text-muted-foreground">{t('settings.workspaces.export.expires', { time: new Date(exportExpiresAt).toLocaleTimeString() })}</div>}
              {selectableFiles.length > 0 && (
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="typography-meta text-muted-foreground">{t('settings.workspaces.export.selectedFiles', { count: String(selectedFileCount) })}</span>
                    <Button size="xs" variant="ghost" onClick={() => setSelectedFileIDs(selectableFiles.map((file) => file.id).filter((id): id is string => Boolean(id)))}>{t('settings.workspaces.export.selectAll')}</Button>
                    <Button size="xs" variant="ghost" onClick={() => setSelectedFileIDs([])}>{t('settings.workspaces.export.clearSelection')}</Button>
                  </div>
                  <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                    {selectableFiles.map((file) => (
                      <label key={file.id} className="flex min-w-0 items-center gap-2 py-0.5">
                        <Checkbox
                          checked={selectedFileIDs.includes(file.id as string)}
                          onChange={(checked) => setSelectedFileIDs((current) => checked
                            ? [...current, file.id as string]
                            : current.filter((id) => id !== file.id))}
                          ariaLabel={t('settings.workspaces.export.fileToggle')}
                        />
                        <span className="min-w-0 flex-1 truncate typography-meta text-foreground">{file.path}</span>
                        <span className="shrink-0 typography-micro text-muted-foreground">+{file.additions} -{file.deletions}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {patch && (
            <>
              <Textarea value={patch} readOnly className="min-h-40 font-mono typography-code text-xs" aria-label={t('settings.workspaces.export.patch')} />
              <div className="flex flex-wrap gap-2">
                <Button size="xs" variant="outline" onClick={() => void checkPatch()} disabled={applyBusy || !targetDirectory || (Boolean(exportID) && selectedFileCount === 0)}>{t('settings.workspaces.export.check')}</Button>
                <Button size="xs" variant="default" onClick={() => void applyPatch()} disabled={applyBusy || !targetDirectory || (Boolean(exportID) && selectedFileCount === 0)}>{t('settings.workspaces.export.apply')}</Button>
              </div>
            </>
          )}
          {exportError && <div className="typography-meta text-[var(--status-error)]">{exportError}</div>}
          {applyMessage && <div className="typography-meta text-muted-foreground">{applyMessage}</div>}
        </div>

        {saving && <div className="typography-meta text-muted-foreground">{t('settings.workspaces.saving')}</div>}
        {saveError && <div className="typography-meta text-[var(--status-error)]">{t('settings.workspaces.saveFailed')}</div>}
      </section>
    </div>
  );
};

function ProviderCard(props: {
  provider: WorkspaceProviderKind;
  title: string;
  description: string;
  selected: boolean;
  status?: WorkspaceProviderValidationResult;
  validating: boolean;
  onSelect: () => void;
  onValidate: () => void;
  validateLabel: string;
  selectedLabel: string;
}) {
  const { t } = useI18n();
  const statusText = props.status
    ? props.status.available
      ? t('settings.workspaces.status.available')
      : props.status.error || t('settings.workspaces.status.unavailable')
    : t('settings.workspaces.status.notChecked');
  return (
    <div className="rounded-lg border border-border bg-[var(--surface-elevated)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">{props.title}</div>
          <div className="typography-meta text-muted-foreground">{props.description}</div>
        </div>
        {props.selected && <span className="typography-micro rounded-full bg-[var(--interactive-selection)] px-2 py-0.5 text-[var(--interactive-selection-foreground)]">{props.selectedLabel}</span>}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={props.status?.available ? 'typography-meta text-[var(--status-success)]' : 'typography-meta text-muted-foreground'}>{statusText}</span>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={props.onSelect}>{t('settings.workspaces.actions.use')}</Button>
          <Button size="xs" variant="outline" onClick={props.onValidate} disabled={props.validating}>{props.validating ? t('settings.workspaces.actions.validating') : props.validateLabel}</Button>
        </div>
      </div>
    </div>
  );
}
