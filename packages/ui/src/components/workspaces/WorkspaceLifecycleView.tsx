import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { WorkspaceApplySelection, WorkspaceArtifactReview, WorkspaceCompatibilityResult, WorkspaceHandoffOperation, WorkspacePrivilegedOperation, WorkspaceProviderKind, WorkspaceReauthProofResult } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { createSessionInWorkspace } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { emptyWorkspaceScopeState, requiredCapabilityForWorkspaceOperation, requiredWorkspaceCapability, workspaceStatusSnapshot, type WorkspaceRequiredCapability, type WorkspaceStatus } from './workspaceSurfaceState';

type WorkspaceListItem = {
  id: string;
  type: string;
  name: string;
  directory?: string | null;
};

type WorkspacePolicy = {
  enabled: boolean;
  provider: WorkspaceProviderKind;
  image: string;
  preserveOnDelete: boolean;
};

const EMPTY_POLICY: WorkspacePolicy = {
  enabled: false,
  provider: 'docker',
  image: '',
  preserveOnDelete: false,
};

export const WorkspaceLifecycleView: React.FC<{ onOpenSettings?: () => void; onSessionStarted?: () => void }> = ({ onOpenSettings, onSessionStarted }) => {
  const { t } = useI18n();
  const runtimeAPIs = useRuntimeAPIs();
  const storeDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionID = useSessionUIStore((state) => state.currentSessionId);
  const directory = storeDirectory || opencodeClient.getDirectory() || '';
  const generationRef = React.useRef(0);
  const pendingCreatedWorkspaceRef = React.useRef<string | null>(null);
  const [initialLoading, setInitialLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [applyBusy, setApplyBusy] = React.useState(false);
  const [policy, setPolicy] = React.useState(EMPTY_POLICY);
  const [compatibility, setCompatibility] = React.useState<WorkspaceCompatibilityResult | null>(null);
  const [workspaceList, setWorkspaceList] = React.useState<WorkspaceListItem[]>([]);
  const [workspaceStatuses, setWorkspaceStatuses] = React.useState<Record<string, WorkspaceStatus>>({});
  const [selectedWorkspaceID, setSelectedWorkspaceID] = React.useState('');
  const [workspaceMessage, setWorkspaceMessage] = React.useState('');
  const [workspaceError, setWorkspaceError] = React.useState('');
  const [workspaceStatusError, setWorkspaceStatusError] = React.useState('');
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = React.useState<string[]>([]);
  const [removeWorkspaceID, setRemoveWorkspaceID] = React.useState<string | null>(null);
  const [exportID, setExportID] = React.useState('');
  const [exportExpiresAt, setExportExpiresAt] = React.useState('');
  const [selections, setSelections] = React.useState<WorkspaceApplySelection[]>([]);
  const [artifactReview, setArtifactReview] = React.useState<WorkspaceArtifactReview | null>(null);
  const [applyMessage, setApplyMessage] = React.useState('');
  const [missingCapabilities, setMissingCapabilities] = React.useState<WorkspaceRequiredCapability[]>([]);
  const [reauthRequest, setReauthRequest] = React.useState<{
    operation: WorkspacePrivilegedOperation;
    project: string;
    payload: Record<string, unknown>;
    resolve: (proof: WorkspaceReauthProofResult | null) => void;
  } | null>(null);
  const [reauthPassword, setReauthPassword] = React.useState('');
  const [reauthBusy, setReauthBusy] = React.useState(false);
  const [reauthError, setReauthError] = React.useState('');
  const [handoff, setHandoff] = React.useState<WorkspaceHandoffOperation | null>(null);
  const [handoffText, setHandoffText] = React.useState('');
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [handoffError, setHandoffError] = React.useState('');

  const clearExportArtifact = React.useCallback(() => {
    setExportID('');
    setExportExpiresAt('');
    setSelections([]);
    setArtifactReview(null);
    setApplyMessage('');
  }, []);

  const resetScope = React.useCallback(() => {
    generationRef.current += 1;
    const empty = emptyWorkspaceScopeState();
    pendingCreatedWorkspaceRef.current = null;
    setWorkspaceList(empty.workspaces);
    setWorkspaceStatuses(empty.statuses);
    setSelectedWorkspaceID(empty.selectedWorkspaceID);
    clearExportArtifact();
    setWorkspaceMessage('');
    setWorkspaceError('');
    setWorkspaceStatusError('');
    setWorkspaceDiagnostics([]);
    setRemoveWorkspaceID(null);
    setMissingCapabilities([]);
    setCompatibility(null);
    setPolicy(EMPTY_POLICY);
    setHandoff(null);
    setHandoffText('');
    setHandoffError('');
  }, [clearExportArtifact]);

  React.useEffect(() => subscribeRuntimeEndpointWillChange(resetScope), [resetScope]);

  const noteCapabilityError = React.useCallback((error: unknown): boolean => {
    const capability = requiredWorkspaceCapability(error);
    if (!capability) return false;
    setMissingCapabilities((current) => current.includes(capability) ? current : [...current, capability]);
    return true;
  }, []);

  const refreshStatuses = React.useCallback(async (expectedGeneration = generationRef.current) => {
    try {
      const statuses = await opencodeClient.experimentalWorkspaces.status(directory || undefined);
      if (expectedGeneration !== generationRef.current) return null;
      setWorkspaceStatuses((current) => workspaceStatusSnapshot(current, statuses));
      setWorkspaceStatusError('');
      return statuses;
    } catch (error) {
      if (expectedGeneration === generationRef.current) {
        setWorkspaceStatusError(error instanceof Error ? error.message : t('settings.workspaces.status.refreshFailed'));
      }
      return null;
    }
  }, [directory, t]);

  const loadWorkspaces = React.useCallback(async (sync = true, expectedGeneration = generationRef.current) => {
    setBusy(true);
    setWorkspaceError('');
    try {
      if (sync) {
        try {
          await opencodeClient.experimentalWorkspaces.syncList(directory || undefined);
        } catch (error) {
          if (expectedGeneration === generationRef.current) {
            setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.status.refreshFailed'));
          }
        }
      }
      const list = await opencodeClient.experimentalWorkspaces.list(directory || undefined);
      if (expectedGeneration !== generationRef.current) return;
      setWorkspaceList(list);
      setSelectedWorkspaceID((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id ?? '');
      await refreshStatuses(expectedGeneration);
    } catch (error) {
      if (expectedGeneration === generationRef.current) {
        setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
      }
    } finally {
      if (expectedGeneration === generationRef.current) setBusy(false);
    }
  }, [directory, refreshStatuses, t]);

  React.useEffect(() => {
    resetScope();
    const generation = generationRef.current;
    setInitialLoading(true);
    void (async () => {
      try {
        const [settingsResult, compatibilityResult] = await Promise.all([
          runtimeAPIs.settings.load(),
          runtimeAPIs.workspaces?.compatibility({ directory: directory || undefined }).catch(() => null) ?? Promise.resolve(null),
        ]);
        if (generation !== generationRef.current) return;
        const settings = settingsResult.settings;
        setPolicy({
          enabled: settings.secureWorkspacesEnabled === true,
          provider: settings.secureWorkspacesDefaultProvider === 'kubernetes' || settings.secureWorkspacesDefaultProvider === 'apple-container'
            ? settings.secureWorkspacesDefaultProvider
            : 'docker',
          image: typeof settings.secureWorkspacesImage === 'string' ? settings.secureWorkspacesImage.trim() : '',
          preserveOnDelete: settings.secureWorkspacesRetentionPreserveOnDelete === true,
        });
        setCompatibility(compatibilityResult);
        await loadWorkspaces(true, generation);
      } catch (error) {
        if (generation === generationRef.current) {
          setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
        }
      } finally {
        if (generation === generationRef.current) setInitialLoading(false);
      }
    })();
  }, [directory, loadWorkspaces, resetScope, runtimeAPIs.settings, runtimeAPIs.workspaces, t]);

  React.useEffect(() => sessionEvents.onWorkspaceEvent((event) => {
    if (event.type === 'status') {
      setWorkspaceStatuses((current) => ({ ...current, [event.workspaceID]: event.status }));
      if (event.status === 'connected' && pendingCreatedWorkspaceRef.current === event.workspaceID) {
        pendingCreatedWorkspaceRef.current = null;
        setWorkspaceMessage(t('settings.workspaces.lifecycle.created'));
      }
      return;
    }
    void loadWorkspaces(false);
  }), [loadWorkspaces, t]);

  React.useEffect(() => {
    if (workspaceList.length === 0) return;
    const timer = window.setInterval(() => void refreshStatuses(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshStatuses, workspaceList.length]);

  function reauthenticate(operation: WorkspacePrivilegedOperation, project: string, payload: Record<string, unknown>) {
    if (!runtimeAPIs.workspaces) return Promise.resolve(null);
    const required = requiredCapabilityForWorkspaceOperation(operation);
    if (required && missingCapabilities.includes(required)) return Promise.resolve(null);
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
      if (noteCapabilityError(error)) {
        reauthRequest.resolve(null);
        setReauthRequest(null);
        setReauthPassword('');
      } else {
        setReauthError(error instanceof Error ? error.message : t('settings.workspaces.reauth.failed'));
      }
    } finally {
      setReauthBusy(false);
    }
  }

  async function createWorkspace() {
    if (!runtimeAPIs.workspaces) return;
    setBusy(true);
    setWorkspaceError('');
    setWorkspaceMessage('');
    try {
      const payload = { type: policy.provider, directory, extra: { image: policy.image } };
      const reauth = await reauthenticate('workspace.create', directory || 'host', payload);
      if (!reauth) return;
      const created = await runtimeAPIs.workspaces.create({ ...payload, reauthProof: reauth.proof, reauthNonce: reauth.nonce });
      setSelectedWorkspaceID(created.id);
      setWorkspaceList((current) => current.some((item) => item.id === created.id) ? current : [...current, created]);
      pendingCreatedWorkspaceRef.current = created.status === 'connected' ? null : created.id;
      setWorkspaceMessage(t(created.status === 'connected' ? 'settings.workspaces.lifecycle.created' : 'settings.workspaces.status.connecting'));
      await refreshStatuses();
    } catch (error) {
      pendingCreatedWorkspaceRef.current = null;
      if (!noteCapabilityError(error)) setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function startSession() {
    if (!selectedWorkspaceID) return;
    setBusy(true);
    setWorkspaceError('');
    try {
      await createSessionInWorkspace(selectedWorkspaceID, undefined, directory || undefined);
      useUIStore.getState().setActiveMainTab('chat');
      onSessionStarted?.();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.startFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function createHandoffDraft(targetWorkspaceID: string | null) {
    if (!currentSessionID || !runtimeAPIs.workspaces) return;
    setHandoffBusy(true);
    setHandoffError('');
    try {
      const source = await opencodeClient.getSession(currentSessionID, directory || undefined);
      const operation = await runtimeAPIs.workspaces.createHandoffDraft({
        projectID: source.projectID,
        directory: source.directory,
        sourceSessionID: source.id,
        sourceWorkspaceID: source.workspaceID ?? null,
        targetWorkspaceID,
      });
      setHandoff(operation);
      setHandoffText(operation.draft?.text ?? '');
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.handoff.draftFailed'));
    } finally {
      setHandoffBusy(false);
    }
  }

  async function commitHandoff() {
    if (!handoff?.draft || !runtimeAPIs.workspaces || handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError('');
    try {
      const completed = await runtimeAPIs.workspaces.commitHandoff({
        ...handoff.binding,
        operationID: handoff.operationID,
        draftID: handoff.draft.id,
        draftRevision: handoff.draft.revision,
        draftHash: handoff.draft.hash,
        text: handoffText,
      });
      setHandoff(completed);
      if (completed.state !== 'completed' || !completed.targetSessionID) throw new Error(t('settings.workspaces.handoff.verifyFailed'));
    } catch (error) {
      if ((error as { cleanupRequired?: boolean })?.cleanupRequired && runtimeAPIs.workspaces) {
        const recovered = await runtimeAPIs.workspaces.inspectHandoff(handoff.operationID).catch(() => null);
        if (recovered) setHandoff({ ...recovered, draft: handoff.draft });
      }
      setHandoffError(error instanceof Error ? error.message : t('settings.workspaces.handoff.commitFailed'));
    } finally {
      setHandoffBusy(false);
    }
  }

  async function openHandoffSession(sessionID: string) {
    if (!handoff || handoff.state !== 'completed') return;
    await useSessionUIStore.getState().setCurrentSession(sessionID, handoff.binding.directory);
    useUIStore.getState().setActiveMainTab('chat');
    onSessionStarted?.();
  }

  async function cleanupHandoffTarget() {
    if (!handoff || !runtimeAPIs.workspaces) return;
    setHandoffBusy(true);
    setHandoffError('');
    try {
      const recovered = await runtimeAPIs.workspaces.cleanupHandoffTarget(handoff.operationID);
      setHandoff({ ...recovered, draft: handoff.draft });
      setHandoffError(t('settings.workspaces.handoff.cleanupComplete'));
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : t('settings.workspaces.handoff.cleanupFailed'));
    } finally {
      setHandoffBusy(false);
    }
  }

  async function reconcileSelectedWorkspace() {
    if (!selectedWorkspaceID || !runtimeAPIs.workspaces) return;
    setBusy(true);
    setWorkspaceError('');
    setWorkspaceDiagnostics([]);
    const payload = { id: selectedWorkspaceID, directory };
    try {
      const reauth = await reauthenticate('workspace.reconcile', directory || 'host', payload);
      if (!reauth) return;
      const result = await runtimeAPIs.workspaces.reconcileWorkspace({ ...payload, reauthProof: reauth.proof, reauthNonce: reauth.nonce });
      setWorkspaceDiagnostics([...result.diagnostics, ...(result.remainingResources ?? [])]);
      if (!result.reconciled) setWorkspaceError(result.error || t('settings.workspaces.lifecycle.reconcileFailed'));
      else setWorkspaceMessage(t('settings.workspaces.lifecycle.reconciled'));
      await refreshStatuses();
    } catch (error) {
      if (!noteCapabilityError(error)) setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.reconcileFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemoveWorkspace() {
    const id = removeWorkspaceID;
    if (!id || !runtimeAPIs.workspaces) return;
    setBusy(true);
    setWorkspaceError('');
    setWorkspaceDiagnostics([]);
    const payload = { id, directory };
    try {
      const reauth = await reauthenticate('workspace.cleanup', directory || 'host', payload);
      if (!reauth) return;
      const result = await runtimeAPIs.workspaces.cleanup({ ...payload, reauthProof: reauth.proof, reauthNonce: reauth.nonce });
      setWorkspaceDiagnostics([...(result.diagnostics ?? []), ...(result.remainingResources ?? [])]);
      if (!result.cleaned) {
        setWorkspaceError(result.error || t('settings.workspaces.lifecycle.cleanupIncomplete'));
        return;
      }
      setRemoveWorkspaceID(null);
      setWorkspaceMessage(t('settings.workspaces.lifecycle.deleted'));
      clearExportArtifact();
      await loadWorkspaces(false);
    } catch (error) {
      if (!noteCapabilityError(error)) setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function exportSelectedWorkspace() {
    if (!selectedWorkspaceID || !runtimeAPIs.workspaces) return;
    setBusy(true);
    setWorkspaceError('');
    try {
      const payload = { id: selectedWorkspaceID, directory };
      const reauth = await reauthenticate('workspace.export', directory || 'host', payload);
      if (!reauth) return;
      const exported = await runtimeAPIs.workspaces.exportWorkspace({ ...payload, reauthProof: reauth.proof, reauthNonce: reauth.nonce });
      setExportID(exported.exportID);
      setExportExpiresAt(exported.expiresAt);
      setArtifactReview(exported.review);
      setSelections(exported.review.files.map((file) => ({ fileID: file.id, ...(file.textHunks.length ? { hunkIDs: file.textHunks.map((hunk) => hunk.id) } : {}) })));
    } catch (error) {
      if (!noteCapabilityError(error)) setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function applyExport(checkOnly: boolean) {
    if (!runtimeAPIs.workspaces || !exportID || !directory || !selectedWorkspaceID) return;
    if (!checkOnly && !window.confirm(t('settings.workspaces.export.confirmApply'))) return;
    setApplyBusy(true);
    setApplyMessage('');
    try {
      const payload = { directory, exportID, selections, workspaceID: selectedWorkspaceID, checkOnly };
      const reauth = await reauthenticate('host.apply', directory, payload);
      if (!reauth) return;
      const result = await runtimeAPIs.workspaces.applyExport({ ...payload, reauthProof: reauth.proof, reauthNonce: reauth.nonce });
      setApplyMessage(result.error || (checkOnly ? t('settings.workspaces.export.checkPassed') : t('settings.workspaces.export.applied')));
      if (result.error) noteCapabilityError(result.error);
    } catch (error) {
      if (!noteCapabilityError(error)) setApplyMessage(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setApplyBusy(false);
    }
  }

  async function downloadExport() {
    if (!runtimeAPIs.workspaces || !exportID || !selectedWorkspaceID) return;
    setApplyBusy(true);
    try {
      const result = await runtimeAPIs.workspaces.downloadArtifact({ exportID, workspaceID: selectedWorkspaceID });
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (!noteCapabilityError(error)) setApplyMessage(error instanceof Error ? error.message : t('settings.workspaces.export.downloadFailed'));
    } finally {
      setApplyBusy(false);
    }
  }

  async function discardExport() {
    if (!runtimeAPIs.workspaces || !exportID || !selectedWorkspaceID) return;
    if (!window.confirm(t('settings.workspaces.export.confirmDiscard'))) return;
    setApplyBusy(true);
    try {
      await runtimeAPIs.workspaces.discardArtifact({ exportID, workspaceID: selectedWorkspaceID });
      clearExportArtifact();
    } catch (error) {
      if (!noteCapabilityError(error)) setApplyMessage(error instanceof Error ? error.message : t('settings.workspaces.export.discardFailed'));
    } finally {
      setApplyBusy(false);
    }
  }

  function openSettings() {
    if (onOpenSettings) {
      onOpenSettings();
      return;
    }
    useUIStore.getState().setSettingsPage('workspaces');
    useUIStore.getState().setSettingsDialogOpen(true);
  }

  const selectedWorkspace = workspaceList.find((workspace) => workspace.id === selectedWorkspaceID) ?? null;
  const selectedStatus = selectedWorkspace ? workspaceStatuses[selectedWorkspace.id] : undefined;
  const selectionFor = (fileID: string) => selections.find((selection) => selection.fileID === fileID);
  const adminBlocked = missingCapabilities.includes('workspace.admin');
  const applyBlocked = missingCapabilities.includes('host.apply');
  const configured = policy.enabled && compatibility?.configured !== false;
  const toggleFile = (fileID: string, hunkIDs: string[], checked: boolean) => setSelections((current) => checked
    ? [...current.filter((selection) => selection.fileID !== fileID), { fileID, ...(hunkIDs.length ? { hunkIDs } : {}) }]
    : current.filter((selection) => selection.fileID !== fileID));
  const toggleHunk = (fileID: string, hunkID: string, checked: boolean) => setSelections((current) => {
    const existing = current.find((selection) => selection.fileID === fileID);
    const next = checked ? [...(existing?.hunkIDs ?? []), hunkID] : (existing?.hunkIDs ?? []).filter((id) => id !== hunkID);
    return next.length ? [...current.filter((selection) => selection.fileID !== fileID), { fileID, hunkIDs: next }] : current.filter((selection) => selection.fileID !== fileID);
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/50 px-4 py-3 md:px-6">
        <div className="min-w-0">
          <h1 className="typography-ui-header text-lg font-semibold text-foreground">{t('settings.workspaces.title')}</h1>
          <p className="truncate typography-meta text-muted-foreground">{directory || t('settings.workspaces.export.directory')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProviderBadge provider={selectedWorkspace?.type ?? policy.provider} />
          {selectedWorkspace ? <StatusBadge status={selectedStatus} /> : null}
          <Button size="sm" variant="outline" onClick={() => void loadWorkspaces()} disabled={busy}>{t('settings.workspaces.export.load')}</Button>
          <Button size="sm" variant="ghost" onClick={openSettings}>{t('gitView.pr.actions.openSettings')}</Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto grid w-full max-w-6xl gap-5 lg:grid-cols-[minmax(15rem,0.72fr)_minmax(0,1.28fr)]">
          <section className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{t('settings.workspaces.lifecycle.title')}</h2>
              <Button size="sm" onClick={() => void createWorkspace()} disabled={busy || adminBlocked || !configured || !policy.image || !directory}>{t('settings.workspaces.lifecycle.create')}</Button>
            </div>
            {initialLoading ? <p className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
            {!initialLoading && !configured ? (
              <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-muted)] p-4">
                <p className="typography-ui text-foreground">{t('settings.workspaces.compatibility.notConfigured')}</p>
                <Button size="sm" onClick={openSettings}>{t('gitView.pr.actions.openSettings')}</Button>
              </div>
            ) : null}
            {!initialLoading && configured && workspaceList.length === 0 ? <p className="rounded-lg border border-dashed border-border p-5 text-center typography-meta text-muted-foreground">{t('settings.workspaces.lifecycle.empty')}</p> : null}
            <div className="space-y-2">
              {workspaceList.map((workspace) => {
                const selected = workspace.id === selectedWorkspaceID;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className={cn('flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', selected ? 'border-[var(--interactive-border)] bg-interactive-selection text-interactive-selection-foreground' : 'border-border hover:bg-interactive-hover')}
                    onClick={() => { setSelectedWorkspaceID(workspace.id); clearExportArtifact(); }}
                    aria-pressed={selected}
                  >
                    <span className="min-w-0 truncate typography-ui-label font-medium">{workspace.name || workspace.id}</span>
                    <span className="flex shrink-0 items-center gap-1.5"><ProviderBadge provider={workspace.type} /><StatusBadge status={workspaceStatuses[workspace.id]} /></span>
                  </button>
                );
              })}
            </div>
            {missingCapabilities.length > 0 ? (
              <p className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning-foreground)]" role="status">
                {t(applyBlocked ? 'settings.workspaces.capability.hostApplyRequired' : 'settings.workspaces.capability.adminRequired')}
              </p>
            ) : null}
            {workspaceError ? <p className="typography-meta text-[var(--status-error)]" role="alert">{workspaceError}</p> : null}
            {workspaceStatusError ? <p className="typography-meta text-[var(--status-error)]" role="alert">{workspaceStatusError}</p> : null}
            {workspaceMessage ? <p className="typography-meta text-muted-foreground" role="status">{workspaceMessage}</p> : null}
            {workspaceDiagnostics.length > 0 ? <div className="space-y-1 typography-meta text-muted-foreground">{workspaceDiagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div> : null}
          </section>

          <section className="min-w-0 space-y-5">
            {selectedWorkspace ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="mr-auto typography-ui-label font-semibold text-foreground">{selectedWorkspace.name || selectedWorkspace.id}</h2>
                  <Button size="sm" onClick={() => void startSession()} disabled={busy || selectedStatus !== 'connected'}>{t('settings.workspaces.lifecycle.startSession')}</Button>
                   <Button size="sm" variant="outline" onClick={() => void createHandoffDraft(selectedWorkspace.id)} disabled={busy || handoffBusy || !currentSessionID || selectedStatus !== 'connected'}>{t('settings.workspaces.handoff.continueWorkspace')}</Button>
                   <Button size="sm" variant="outline" onClick={() => void createHandoffDraft(null)} disabled={busy || handoffBusy || !currentSessionID}>{t('settings.workspaces.handoff.continueHost')}</Button>
                  <Button size="sm" variant="outline" onClick={() => void reconcileSelectedWorkspace()} disabled={busy || adminBlocked}>{t('settings.workspaces.lifecycle.reconcile')}</Button>
                  <Button size="sm" variant="destructive" onClick={() => setRemoveWorkspaceID(selectedWorkspace.id)} disabled={busy || adminBlocked}>{t('settings.workspaces.lifecycle.delete')}</Button>
                </div>
                 {!currentSessionID ? <p className="typography-meta text-muted-foreground">{t('settings.workspaces.handoff.noCurrentSession')}</p> : null}
              </div>
            ) : null}

            <div className="space-y-3 border-t border-border pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="typography-ui-label font-semibold text-foreground">{t('settings.workspaces.export.title')}</h2>
                  <p className="typography-meta text-muted-foreground">{t('settings.workspaces.export.description')}</p>
                </div>
                <Button size="sm" onClick={() => void exportSelectedWorkspace()} disabled={busy || adminBlocked || !selectedWorkspaceID}>{t('settings.workspaces.export.review')}</Button>
              </div>
              {artifactReview ? (
                <div className="space-y-3">
                  <p className="typography-meta text-muted-foreground">{t('settings.workspaces.export.summary', { files: String(artifactReview.totalFiles) })}</p>
                  {exportExpiresAt ? <p className="typography-meta text-muted-foreground">{t('settings.workspaces.export.expires', { time: new Date(exportExpiresAt).toLocaleTimeString() })}</p> : null}
                  {artifactReview.files.map((file) => {
                    const selected = selectionFor(file.id);
                    const pathLabel = file.oldPath && file.newPath && file.oldPath !== file.newPath ? `${file.oldPath} -> ${file.newPath}` : file.newPath ?? file.oldPath ?? '';
                    return (
                      <div key={file.id} className="min-w-0 space-y-2 border-t border-border pt-3 first:border-t-0">
                        <label className="flex min-w-0 items-center gap-2">
                          <Checkbox checked={Boolean(selected)} onChange={(checked) => toggleFile(file.id, file.textHunks.map((hunk) => hunk.id), checked)} ariaLabel={t('settings.workspaces.export.fileToggle')} />
                          <span className="min-w-0 flex-1 truncate font-mono typography-meta text-foreground">{pathLabel}</span>
                          <span className="typography-micro text-muted-foreground">{file.kind}</span>
                        </label>
                        {file.textHunks.length > 0 ? file.textHunks.map((hunk) => (
                          <div key={hunk.id} className="ml-5 space-y-1 sm:ml-7">
                            <label className="flex items-center gap-2">
                              <Checkbox checked={selected?.hunkIDs?.includes(hunk.id) === true} onChange={(checked) => toggleHunk(file.id, hunk.id, checked)} ariaLabel={t('settings.workspaces.export.hunkToggle')} />
                              <span className="typography-micro text-muted-foreground">{`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`}</span>
                            </label>
                            <pre className="max-h-64 overflow-auto rounded-md bg-[var(--surface-elevated)] p-2 font-mono typography-code text-xs">
                              {hunk.removed.map((line, index) => <span key={`r-${index}`} className="block bg-[color-mix(in_srgb,var(--syntax-keyword)_12%,transparent)] text-[var(--syntax-keyword)]">-{line}</span>)}
                              {hunk.added.map((line, index) => <span key={`a-${index}`} className="block bg-[color-mix(in_srgb,var(--syntax-string)_12%,transparent)] text-[var(--syntax-string)]">+{line}</span>)}
                            </pre>
                          </div>
                        )) : <p className="ml-7 typography-meta text-muted-foreground">{file.binary ? t('settings.workspaces.export.binaryWholeFile') : t('settings.workspaces.export.wholeOperation')}</p>}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {exportID ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void applyExport(true)} disabled={applyBusy || applyBlocked || selections.length === 0}>{t('settings.workspaces.export.check')}</Button>
                  <Button size="sm" onClick={() => void applyExport(false)} disabled={applyBusy || applyBlocked || selections.length === 0}>{t('settings.workspaces.export.apply')}</Button>
                  <Button size="sm" variant="outline" onClick={() => void downloadExport()} disabled={applyBusy || adminBlocked}>{t('settings.workspaces.export.download')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void discardExport()} disabled={applyBusy || adminBlocked}>{t('settings.workspaces.export.discard')}</Button>
                </div>
              ) : null}
              {applyMessage ? <p className="typography-meta text-muted-foreground" role="status">{applyMessage}</p> : null}
            </div>
          </section>
        </div>
      </div>

      <Dialog open={reauthRequest !== null} onOpenChange={(open) => { if (!open) cancelReauthentication(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('settings.workspaces.reauth.title')}</DialogTitle><DialogDescription>{t('settings.workspaces.reauth.prompt')}</DialogDescription></DialogHeader>
          <Input type="password" autoComplete="current-password" value={reauthPassword} onChange={(event) => setReauthPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void confirmReauthentication(); }} placeholder={t('sessionAuth.password.placeholder')} aria-label={t('sessionAuth.password.placeholder')} disabled={reauthBusy} autoFocus />
          {reauthError ? <p className="typography-meta text-[var(--status-error)]" role="alert">{reauthError}</p> : null}
          <DialogFooter><Button variant="ghost" onClick={cancelReauthentication} disabled={reauthBusy}>{t('settings.common.actions.cancel')}</Button><Button size="sm" onClick={() => void confirmReauthentication()} disabled={reauthBusy}>{t('settings.workspaces.reauth.confirm')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={removeWorkspaceID !== null} onOpenChange={(open) => { if (!open && !busy) setRemoveWorkspaceID(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('settings.workspaces.lifecycle.confirmDeleteTitle')}</DialogTitle><DialogDescription>{policy.preserveOnDelete ? t('settings.workspaces.lifecycle.confirmDeletePreserve') : t('settings.workspaces.lifecycle.confirmDelete')}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="ghost" onClick={() => setRemoveWorkspaceID(null)} disabled={busy}>{t('settings.common.actions.cancel')}</Button><Button variant="destructive" onClick={() => void confirmRemoveWorkspace()} disabled={busy}>{t('settings.workspaces.lifecycle.delete')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={handoff !== null} onOpenChange={(open) => { if (!open && !handoffBusy) { setHandoff(null); setHandoffText(''); setHandoffError(''); } }}>
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('settings.workspaces.handoff.title')}</DialogTitle>
            <DialogDescription>{t('settings.workspaces.handoff.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning-foreground)]">
              <p>{t('settings.workspaces.handoff.fidelityWarning')}</p>
              <p>{t('settings.workspaces.handoff.sourceUnchanged')}</p>
              <p>{t('settings.workspaces.handoff.filesWarning')}</p>
            </div>
            {handoff?.state === 'completed' ? <p className="typography-ui text-foreground" role="status">{t('settings.workspaces.handoff.completed')}</p> : null}
            {handoff?.draft?.omissions.length ? (
              <p className="typography-meta text-muted-foreground">{t('settings.workspaces.handoff.omissions', { count: String(handoff.draft.omissions.reduce((total, item) => total + item.count, 0)) })}</p>
            ) : null}
            {handoff?.draft ? <Textarea value={handoffText} onChange={(event) => setHandoffText(event.target.value)} rows={14} maxLength={64000} aria-label={t('settings.workspaces.handoff.contextAria')} disabled={handoffBusy} /> : null}
            {handoffError ? <p className="typography-meta text-[var(--status-error)]" role="alert">{handoffError}</p> : null}
          </div>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => { setHandoff(null); setHandoffText(''); setHandoffError(''); }} disabled={handoffBusy}>{t('settings.common.actions.cancel')}</Button>
            {handoff?.state === 'completed' ? <Button variant="outline" onClick={() => void openHandoffSession(handoff.binding.sourceSessionID)}>{t('settings.workspaces.handoff.openSource')}</Button> : null}
            {handoff?.state === 'completed' && handoff.targetSessionID ? <Button onClick={() => void openHandoffSession(handoff.targetSessionID!)}>{t('settings.workspaces.handoff.openTarget')}</Button> : null}
            {handoff?.state === 'cleanup-required' ? <Button variant="destructive" onClick={() => void cleanupHandoffTarget()} disabled={handoffBusy}>{t('settings.workspaces.handoff.cleanupTarget')}</Button> : null}
            {handoff?.draft ? <Button onClick={() => void commitHandoff()} disabled={handoffBusy || !handoffText.trim()}>{t('settings.workspaces.handoff.confirm')}</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

function ProviderBadge({ provider }: { provider: string }) {
  const { t } = useI18n();
  const label = provider === 'apple-container' ? t('settings.workspaces.provider.appleContainer') : provider === 'kubernetes' ? t('settings.workspaces.provider.kubernetes') : provider === 'docker' ? t('settings.workspaces.provider.docker') : provider;
  return <span className="rounded-full bg-[var(--interactive-selection)] px-2 py-0.5 typography-micro text-[var(--interactive-selection-foreground)]">{label}</span>;
}

function StatusBadge({ status }: { status?: WorkspaceStatus }) {
  const { t } = useI18n();
  const key = status ? `settings.workspaces.status.${status}` as const : 'settings.workspaces.status.unknown' as const;
  return <span className={cn('rounded-full px-2 py-0.5 typography-micro', status === 'connected' ? 'bg-[var(--status-success)]/10 text-[var(--status-success)]' : status === 'error' ? 'bg-[var(--status-error)]/10 text-[var(--status-error)]' : 'bg-[var(--surface-elevated)] text-muted-foreground')}>{t(key)}</span>;
}
