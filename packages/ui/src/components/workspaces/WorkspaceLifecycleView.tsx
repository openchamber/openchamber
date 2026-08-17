import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { WorkspaceApplySelection, WorkspaceArtifactReview, WorkspaceCompatibilityResult, WorkspaceHandoffOperation, WorkspaceProviderKind } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { createSessionInWorkspace } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { emptyWorkspaceScopeState, requiredCapabilityForWorkspaceOperation, requiredWorkspaceCapability, workspaceProjectDirectory, workspaceSourceRefusal, workspaceStatusSnapshot, type WorkspaceRequiredCapability, type WorkspaceStatus } from './workspaceSurfaceState';
import { useWorkspaceReauth } from './WorkspaceReauth';

type WorkspaceListItem = {
  id: string;
  type: string;
  name: string;
  directory?: string | null;
};

type WorkspacePolicy = {
  enabled: boolean;
  provider: WorkspaceProviderKind;
  preserveOnDelete: boolean;
};

const EMPTY_POLICY: WorkspacePolicy = {
  enabled: false,
  provider: 'docker',
  preserveOnDelete: false,
};

export const WorkspaceLifecycleView: React.FC<{ onOpenSettings?: () => void; onSessionStarted?: () => void; onClose?: () => void }> = ({ onOpenSettings, onSessionStarted, onClose }) => {
  const { t } = useI18n();
  const runtimeAPIs = useRuntimeAPIs();
  const currentSessionID = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const [manualDirectory, setManualDirectory] = React.useState('');
  const scopedDirectory = workspaceProjectDirectory(projects, activeProjectId, newSessionDraft, currentSessionDirectory);
  const directory = scopedDirectory || manualDirectory;
  const generationRef = React.useRef(0);
  const directoryRef = React.useRef(directory);
  directoryRef.current = directory;
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
  const [applyFailed, setApplyFailed] = React.useState(false);
  const [missingCapabilities, setMissingCapabilities] = React.useState<WorkspaceRequiredCapability[]>([]);
  const [handoff, setHandoff] = React.useState<WorkspaceHandoffOperation | null>(null);
  const [handoffText, setHandoffText] = React.useState('');
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [handoffError, setHandoffError] = React.useState('');
  const [operation, setOperation] = React.useState<'creating' | 'deleting' | 'repairing' | 'exporting' | 'checking' | 'applying' | null>(null);
  const [driftedWorkspaces, setDriftedWorkspaces] = React.useState<Set<string>>(new Set());

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
    setManualDirectory('');
    setApplyFailed(false);
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
    setDriftedWorkspaces(new Set());
  }, [clearExportArtifact]);

  React.useEffect(() => subscribeRuntimeEndpointWillChange(resetScope), [resetScope]);

  const noteCapabilityError = React.useCallback((error: unknown): boolean => {
    const capability = requiredWorkspaceCapability(error);
    if (!capability) return false;
    setMissingCapabilities((current) => current.includes(capability) ? current : [...current, capability]);
    return true;
  }, []);

  const missingCapabilitiesRef = React.useRef(missingCapabilities);
  missingCapabilitiesRef.current = missingCapabilities;
  const reauth = useWorkspaceReauth({
    shouldSkip: (operation) => {
      const required = requiredCapabilityForWorkspaceOperation(operation);
      return Boolean(required && missingCapabilitiesRef.current.includes(required));
    },
    onError: noteCapabilityError,
  });
  // Nothing on this panel asks for a credential any more: authorization is the capability
  // check, and only changing the policy — which lives in settings, not here — still needs
  // a proof. `reauth` stays for its dialog, which the settings surface renders through the
  // same hook.

  const refreshStatuses = React.useCallback(async (expectedGeneration = generationRef.current) => {
    const requestedDirectory = directory;
    try {
      const statuses = await opencodeClient.experimentalWorkspaces.status(requestedDirectory || undefined);
      if (expectedGeneration !== generationRef.current || requestedDirectory !== directoryRef.current) return null;
      setWorkspaceStatuses((current) => workspaceStatusSnapshot(current, statuses));
      setWorkspaceStatusError('');
      return statuses;
    } catch (error) {
      if (expectedGeneration === generationRef.current && requestedDirectory === directoryRef.current) {
        setWorkspaceStatusError(error instanceof Error ? error.message : t('settings.workspaces.status.refreshFailed'));
      }
      return null;
    }
  }, [directory, t]);

  const loadWorkspaces = React.useCallback(async (sync = true, expectedGeneration = generationRef.current) => {
    const requestedDirectory = directory;
    setBusy(true);
    try {
      if (sync) {
        try {
          await opencodeClient.experimentalWorkspaces.syncList(requestedDirectory || undefined);
        } catch (error) {
          if (expectedGeneration === generationRef.current && requestedDirectory === directoryRef.current) {
            setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.status.refreshFailed'));
          }
        }
        try {
          await opencodeClient.experimentalWorkspaces.startSync(requestedDirectory || undefined);
        } catch (error) {
          if (expectedGeneration === generationRef.current && requestedDirectory === directoryRef.current) {
            setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.status.refreshFailed'));
          }
        }
      }
      const list = await opencodeClient.experimentalWorkspaces.list(requestedDirectory || undefined);
      if (expectedGeneration !== generationRef.current || requestedDirectory !== directoryRef.current) return;
      setWorkspaceList(list);
      setSelectedWorkspaceID((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id ?? '');
      let statuses = await refreshStatuses(expectedGeneration);
      if (sync && list.length > 0) {
        for (let attempt = 0; attempt < 20 && !statuses?.some((item) => list.some((workspace) => workspace.id === item.workspaceID)); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          if (expectedGeneration !== generationRef.current) return;
          statuses = await refreshStatuses(expectedGeneration);
        }
        if (!statuses?.some((item) => list.some((workspace) => workspace.id === item.workspaceID))) {
          setWorkspaceStatusError(t('settings.workspaces.status.refreshFailed'));
        }
      }
    } catch (error) {
      if (expectedGeneration === generationRef.current && requestedDirectory === directoryRef.current) {
        setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
      }
    } finally {
      if (expectedGeneration === generationRef.current && requestedDirectory === directoryRef.current) setBusy(false);
    }
  }, [directory, refreshStatuses, t]);

  React.useEffect(() => {
    resetScope();
    const generation = generationRef.current;
    const requestedDirectory = directory;
    setInitialLoading(true);
    void (async () => {
      try {
        const [settingsResult, compatibilityResult] = await Promise.all([
          runtimeAPIs.settings.load(),
          runtimeAPIs.workspaces?.compatibility({ directory: directory || undefined }).catch(() => null) ?? Promise.resolve(null),
        ]);
        if (generation !== generationRef.current || requestedDirectory !== directoryRef.current) return;
        const settings = settingsResult.settings;
        setPolicy({
          enabled: settings.secureWorkspacesEnabled === true,
          provider: settings.secureWorkspacesDefaultProvider === 'kubernetes' || settings.secureWorkspacesDefaultProvider === 'apple-container'
            ? settings.secureWorkspacesDefaultProvider
            : 'docker',
          preserveOnDelete: settings.secureWorkspacesRetentionPreserveOnDelete === true,
        });
        setCompatibility(compatibilityResult);
        await loadWorkspaces(true, generation);
      } catch (error) {
        if (generation === generationRef.current && requestedDirectory === directoryRef.current) {
          setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
        }
      } finally {
        if (generation === generationRef.current && requestedDirectory === directoryRef.current) setInitialLoading(false);
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
    // Settings are read once when this view loads, so a provider chosen afterwards left
    // the create button offering the old one until the view was rebuilt from scratch.
    if (event.type === 'policy-changed') {
      void (async () => {
        try {
          const result = await runtimeAPIs.settings.load();
          const settings = result.settings;
          setPolicy({
            enabled: settings.secureWorkspacesEnabled === true,
            provider: settings.secureWorkspacesDefaultProvider === 'kubernetes' || settings.secureWorkspacesDefaultProvider === 'apple-container'
              ? settings.secureWorkspacesDefaultProvider
              : 'docker',
            preserveOnDelete: settings.secureWorkspacesRetentionPreserveOnDelete === true,
          });
        } catch {
          // A failed re-read leaves the previous policy in place rather than a guess.
        }
      })();
      return;
    }
    void loadWorkspaces(false);
  }), [loadWorkspaces, runtimeAPIs.settings, t]);

  // Which workspaces predate the current settings is recorded in each workspace, so it
  // can be shown beside them instead of surfacing as a refused operation later.
  React.useEffect(() => {
    if (workspaceList.length === 0 || !runtimeAPIs.workspaces?.policyState) {
      setDriftedWorkspaces(new Set());
      return;
    }
    let cancelled = false;
    runtimeAPIs.workspaces.policyState({ directory: directory || undefined })
      .then((result) => { if (!cancelled) setDriftedWorkspaces(new Set(result.mismatched)); })
      .catch(() => { if (!cancelled) setDriftedWorkspaces(new Set()); });
    return () => { cancelled = true; };
  }, [workspaceList, directory, runtimeAPIs.workspaces]);

  React.useEffect(() => {
    if (workspaceList.length === 0) return;
    const timer = window.setInterval(() => void refreshStatuses(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshStatuses, workspaceList.length]);

  async function createWorkspace() {
    if (!runtimeAPIs.workspaces) return;
    setBusy(true);
    setOperation('creating');
    setWorkspaceError('');
    setWorkspaceMessage('');
    try {
      const payload = { type: policy.provider, directory, extra: null };
      const created = await runtimeAPIs.workspaces.create(payload);
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
      setOperation(null);
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
      setOperation(null);
    }
  }

  // Where the current chat runs decides which move directions make sense at all;
  // undefined means unknown (still loading or lookup failed) and keeps both offered.
  const [currentChatWorkspaceID, setCurrentChatWorkspaceID] = React.useState<string | null | undefined>(undefined);
  React.useEffect(() => {
    let cancelled = false;
    setCurrentChatWorkspaceID(undefined);
    if (!currentSessionID) return;
    opencodeClient.getSession(currentSessionID, directory || undefined)
      .then((session) => { if (!cancelled) setCurrentChatWorkspaceID(session.workspaceID ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentSessionID, directory]);

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
    setOperation('repairing');
    setWorkspaceError('');
    setWorkspaceDiagnostics([]);
    const payload = { id: selectedWorkspaceID, directory };
    try {
      const result = await runtimeAPIs.workspaces.reconcileWorkspace(payload);
      setWorkspaceDiagnostics([...result.diagnostics, ...(result.remainingResources ?? [])]);
      if (!result.reconciled) setWorkspaceError(result.error || t('settings.workspaces.lifecycle.reconcileFailed'));
      else setWorkspaceMessage(t('settings.workspaces.lifecycle.reconciled'));
      await refreshStatuses();
    } catch (error) {
      if (!noteCapabilityError(error)) setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.reconcileFailed'));
    } finally {
      setBusy(false);
      setOperation(null);
    }
  }

  async function confirmRemoveWorkspace() {
    const id = removeWorkspaceID;
    if (!id || !runtimeAPIs.workspaces) return;
    setBusy(true);
    setOperation('deleting');
    setWorkspaceError('');
    setWorkspaceDiagnostics([]);
      const payload = { id, directory };
      try {
        // The confirmation has done its job once it is confirmed. Leaving it up during a
        // removal that takes a while left a dialog of dead buttons in front of the panel,
        // dimming the progress banner that reports what is actually happening.
        setRemoveWorkspaceID(null);
        const result = await runtimeAPIs.workspaces.cleanup(payload);
      setWorkspaceDiagnostics([...(result.diagnostics ?? []), ...(result.remainingResources ?? [])]);
      if (!result.cleaned) {
        setRemoveWorkspaceID(null);
        setWorkspaceError(result.error || t('settings.workspaces.lifecycle.cleanupIncomplete'));
        return;
      }
      setRemoveWorkspaceID(null);
      setWorkspaceMessage(t('settings.workspaces.lifecycle.deleted'));
      clearExportArtifact();
      await loadWorkspaces(false);
    } catch (error) {
      setRemoveWorkspaceID(null);
      if (!noteCapabilityError(error)) setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.lifecycle.deleteFailed'));
    } finally {
      setBusy(false);
      setOperation(null);
    }
  }

  async function exportSelectedWorkspace() {
    if (!selectedWorkspaceID || !runtimeAPIs.workspaces) return;
    setBusy(true);
    setOperation('exporting');
    setWorkspaceError('');
    try {
      const payload = { id: selectedWorkspaceID, directory };
      const exported = await runtimeAPIs.workspaces.exportWorkspace(payload);
      setExportID(exported.exportID);
      setExportExpiresAt(exported.expiresAt);
      setArtifactReview(exported.review);
      // Preselect only what will actually change the host: entries already applied
      // earlier, or conflicting with an external edit, stay visible but unchecked.
      setSelections(exported.review.files
        .filter((file) => (file.hostState ?? 'pending') === 'pending')
        .map((file) => ({ fileID: file.id, ...(file.textHunks.length ? { hunkIDs: file.textHunks.map((hunk) => hunk.id) } : {}) })));
    } catch (error) {
      if (!noteCapabilityError(error)) setWorkspaceError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setBusy(false);
      setOperation(null);
    }
  }

  async function applyExport(checkOnly: boolean) {
    if (!runtimeAPIs.workspaces || !exportID || !directory || !selectedWorkspaceID) return;
    if (!checkOnly && !window.confirm(t('settings.workspaces.export.confirmApply'))) return;
    setApplyBusy(true);
    setOperation(checkOnly ? 'checking' : 'applying');
    setApplyMessage('');
    try {
      const payload = { directory, exportID, selections, workspaceID: selectedWorkspaceID, checkOnly };
      const result = await runtimeAPIs.workspaces.applyExport(payload);
      setApplyFailed(Boolean(result.error));
      setApplyMessage(result.error || (checkOnly ? t('settings.workspaces.export.checkPassed') : t('settings.workspaces.export.applied')));
      if (result.error) noteCapabilityError(result.error);
    } catch (error) {
      setApplyFailed(true);
      if (!noteCapabilityError(error)) setApplyMessage(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setApplyBusy(false);
      setOperation(null);
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
      setApplyFailed(true);
      if (!noteCapabilityError(error)) setApplyMessage(error instanceof Error ? error.message : t('settings.workspaces.export.downloadFailed'));
    } finally {
      setApplyBusy(false);
      setOperation(null);
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
      setApplyFailed(true);
      if (!noteCapabilityError(error)) setApplyMessage(error instanceof Error ? error.message : t('settings.workspaces.export.discardFailed'));
    } finally {
      setApplyBusy(false);
      setOperation(null);
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
  const removeWorkspaceName = workspaceList.find((item) => item.id === removeWorkspaceID)?.name || removeWorkspaceID || '';
  const selectionFor = (fileID: string) => selections.find((selection) => selection.fileID === fileID);
  const adminBlocked = missingCapabilities.includes('workspace.admin');
  const applyBlocked = missingCapabilities.includes('host.apply');
  const configured = policy.enabled && compatibility?.configured !== false;
  // The runtime refuses to copy a home directory or a filesystem root into a workspace.
  // That is knowable from the directory alone, so it is said here rather than left for
  // the person to discover by pressing Create and reading why it failed.
  const sourceRefusal = workspaceSourceRefusal(directory, homeDirectory, compatibility?.platform);
  const projectLabel = projects.find((project) => project.path.trim() === directory)?.label
    ?? (directory ? directory.split(/[\\/]/).filter(Boolean).pop() ?? directory : t('settings.workspaces.lifecycle.noProject'));
  const isPolicyMismatch = (message: string) => /policy fingerprint/i.test(message);
  const policyMismatch = isPolicyMismatch(workspaceError) || isPolicyMismatch(workspaceStatusError) || workspaceDiagnostics.some(isPolicyMismatch);
  const displayWorkspaceError = workspaceError && isPolicyMismatch(workspaceError) ? '' : workspaceError;
  const displayStatusError = workspaceStatusError && isPolicyMismatch(workspaceStatusError) ? '' : workspaceStatusError;
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
          <p className="truncate typography-meta text-muted-foreground">{projectLabel}</p>
        </div>
        {/* Only navigation and refresh live here; workspace actions belong to the
            workspace they act on, not to a toolbar shared by all of them. */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            data-testid="workspace-load"
            onClick={() => void loadWorkspaces()}
            disabled={busy}
            aria-label={t('settings.workspaces.export.load')}
            title={t('settings.workspaces.export.load')}
          >
            <Icon name="refresh" className={cn('size-4', busy && 'animate-spin')} />
          </Button>
          <Button size="sm" variant="ghost" onClick={openSettings}>{t('gitView.pr.actions.openSettings')}</Button>
          {onClose ? <Button size="sm" variant="ghost" data-testid="workspace-close" onClick={onClose}>{t('settings.workspaces.actions.close')}</Button> : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {operation ? (
            <div className="flex items-center gap-2 rounded-md bg-[var(--surface-muted)] px-3 py-2.5" role="status" data-testid="workspace-operation">
              <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="typography-ui text-foreground">{t(`settings.workspaces.progress.${operation}` as const)}</span>
            </div>
          ) : null}
          <section className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{t('settings.workspaces.lifecycle.title')}</h2>
              <Button size="sm" data-testid="workspace-create" onClick={() => void createWorkspace()} disabled={busy || adminBlocked || !configured || !directory || sourceRefusal !== null}>{t('settings.workspaces.lifecycle.createWith', { provider: providerDisplayName(t, policy.provider) })}</Button>
            </div>
            {sourceRefusal ? (
              <div className="space-y-1 rounded-lg border border-border bg-[var(--surface-muted)] p-4" data-testid="workspace-source-refused">
                <p className="typography-ui text-foreground">
                  {sourceRefusal === 'home'
                    ? t('settings.workspaces.lifecycle.sourceIsHome')
                    : t('settings.workspaces.lifecycle.sourceIsRoot')}
                </p>
                <p className="typography-meta text-muted-foreground">{t('settings.workspaces.lifecycle.sourceChooseProject')}</p>
              </div>
            ) : null}
            {initialLoading ? <p className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
            {!initialLoading && !directory && projects.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-muted)] p-4">
                <p className="typography-ui text-foreground">{t('settings.workspaces.lifecycle.chooseProject')}</p>
                <div className="flex flex-col gap-1.5">
                  {projects.map((project) => (
                    <Button key={project.id} size="sm" variant="outline" className="justify-start" onClick={() => setManualDirectory(project.path.trim())}>
                      <span className="truncate">{project.path}</span>
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {!initialLoading && !configured ? (
              <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-muted)] p-4">
                <p className="typography-ui text-foreground">{t('settings.workspaces.compatibility.notConfigured')}</p>
                <Button size="sm" onClick={openSettings}>{t('gitView.pr.actions.openSettings')}</Button>
              </div>
            ) : null}
            {!initialLoading && configured && directory && workspaceList.length === 0 ? (
              <div className="space-y-1 rounded-lg border border-dashed border-border p-5 text-center">
                <p className="typography-meta text-muted-foreground">{t('settings.workspaces.lifecycle.empty')}</p>
                <p className="typography-meta text-muted-foreground">{t('settings.workspaces.lifecycle.emptyHint')}</p>
              </div>
            ) : null}
            <div className="space-y-2">
              {workspaceList.map((workspace) => {
                const selected = workspace.id === selectedWorkspaceID;
                return (
                  <button
                    data-testid="workspace-row"
                    key={workspace.id}
                    type="button"
                    className={cn('flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', selected ? 'border-[var(--interactive-border)] bg-interactive-selection text-interactive-selection-foreground' : 'border-border hover:bg-interactive-hover')}
                    onClick={() => { setSelectedWorkspaceID(workspace.id); clearExportArtifact(); }}
                    aria-pressed={selected}
                  >
                    <span className="min-w-0 truncate typography-ui-label font-medium">{workspace.name || workspace.id}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {driftedWorkspaces.has(workspace.id) ? <SettingsDriftBadge /> : null}
                      <ProviderBadge provider={workspace.type} />
                      <StatusBadge status={workspaceStatuses[workspace.id]} />
                    </span>
                  </button>
                );
              })}
            </div>
            {missingCapabilities.length > 0 ? (
              <p className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-foreground" role="status">
                {t(applyBlocked ? 'settings.workspaces.capability.hostApplyRequired' : 'settings.workspaces.capability.adminRequired')}
              </p>
            ) : null}
            {policyMismatch && driftedWorkspaces.size === 0 ? (
              // Only when no row carries the mark: otherwise this repeats what the list
              // already shows, without saying which workspace it means.
              <div className="space-y-1 rounded-md bg-[var(--status-warning-background)] px-3 py-2" role="alert">
                <p className="typography-meta text-foreground">{t('settings.workspaces.errors.policyMismatch')}</p>
              </div>
            ) : null}
            {displayWorkspaceError ? <p className="typography-meta text-[var(--status-error)]" role="alert">{displayWorkspaceError}</p> : null}
            {displayStatusError ? <p className="typography-meta text-[var(--status-error)]" role="alert">{displayStatusError}</p> : null}
            {workspaceMessage ? <p className="typography-meta text-muted-foreground" role="status">{workspaceMessage}</p> : null}
            {workspaceDiagnostics.length > 0 ? <div className="space-y-1 typography-meta text-muted-foreground">{workspaceDiagnostics.filter((diagnostic) => !isPolicyMismatch(diagnostic)).map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div> : null}
          </section>

          <section className="min-w-0 space-y-5">
            {selectedWorkspace ? (
              <div className="space-y-3">
                {/* No heading here: it repeated the highlighted row directly above, and
                    the identity matters at the irreversible step, which now carries it. */}
                <div
                  className="flex flex-wrap items-center gap-2"
                  role="group"
                  aria-label={t('settings.workspaces.lifecycle.actionsFor', { name: selectedWorkspace.name || selectedWorkspace.id })}
                >
                  <Button size="sm" data-testid="workspace-start-session" onClick={() => void startSession()} disabled={busy || selectedStatus !== 'connected'}>{t('settings.workspaces.lifecycle.startSession')}</Button>
                  <Button size="sm" variant="destructive" data-testid="workspace-delete" onClick={() => setRemoveWorkspaceID(selectedWorkspace.id)} disabled={busy || adminBlocked}>{t('settings.workspaces.lifecycle.delete')}</Button>
                </div>
                {/* Repair belongs to the problem it solves, so it appears only while the
                    workspace is not usable — not as a standing action nobody can place. */}
                {selectedStatus !== 'connected' ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="typography-meta text-muted-foreground">{t('settings.workspaces.lifecycle.connectHint')}</p>
                    <Button size="sm" variant="outline" onClick={() => void reconcileSelectedWorkspace()} disabled={busy || adminBlocked}>{t('settings.workspaces.lifecycle.reconnect')}</Button>
                  </div>
                ) : null}
                {/* Moving a chat is a real feature, not an "advanced" leftover: name it,
                    say what happens, and show it only when there is a chat to move. */}
                {currentSessionID ? (
                  <div className="space-y-1.5 border-t border-border/60 pt-3">
                    <p className="typography-ui-label font-medium text-foreground">{t('settings.workspaces.handoff.moveTitle')}</p>
                    <p className="typography-meta text-muted-foreground">
                      {currentChatWorkspaceID === selectedWorkspace.id
                        ? t('settings.workspaces.handoff.chatAlreadyHere')
                        : t('settings.workspaces.handoff.moveHint')}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      {currentChatWorkspaceID !== selectedWorkspace.id ? (
                        <Button size="sm" variant="outline" onClick={() => void createHandoffDraft(selectedWorkspace.id)} disabled={busy || handoffBusy || selectedStatus !== 'connected'}>{t('settings.workspaces.handoff.moveIntoWorkspace')}</Button>
                      ) : null}
                      {currentChatWorkspaceID !== null ? (
                        <Button size="sm" variant="outline" onClick={() => void createHandoffDraft(null)} disabled={busy || handoffBusy}>{t('settings.workspaces.handoff.moveToHost')}</Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-3 border-t border-border pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="typography-ui-label font-semibold text-foreground">{t('settings.workspaces.export.title')}</h2>
                  <p className="typography-meta text-muted-foreground">{t('settings.workspaces.export.description')}</p>
                </div>
                <Button size="sm" data-testid="workspace-export-review" onClick={() => void exportSelectedWorkspace()} disabled={busy || adminBlocked || !selectedWorkspaceID}>{t('settings.workspaces.export.review')}</Button>
              </div>
              {artifactReview && artifactReview.totalFiles === 0 ? (
                // An empty result used to render as a bare zero-count line, which reads as
                // a failure rather than an answer.
                <p className="typography-meta text-muted-foreground" role="status">{t('settings.workspaces.export.nothingChanged')}</p>
              ) : artifactReview ? (
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
                          {file.hostState === 'applied' ? <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">{t('settings.workspaces.export.alreadyApplied')}</span> : null}
                          {file.hostState === 'conflict' ? <span className="rounded-full bg-[var(--status-warning-background)] px-2 py-0.5 typography-micro text-foreground">{t('settings.workspaces.export.hostChanged')}</span> : null}
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
                  <Button size="sm" variant="outline" data-testid="workspace-apply-dry-run" onClick={() => void applyExport(true)} disabled={applyBusy || applyBlocked || selections.length === 0}>{t('settings.workspaces.export.check')}</Button>
                  <Button size="sm" onClick={() => void applyExport(false)} disabled={applyBusy || applyBlocked || selections.length === 0}>{t('settings.workspaces.export.apply')}</Button>
                  <Button size="sm" variant="outline" onClick={() => void downloadExport()} disabled={applyBusy || adminBlocked}>{t('settings.workspaces.export.download')}</Button>
                  <Button size="sm" variant="ghost" data-testid="workspace-export-discard" onClick={() => void discardExport()} disabled={applyBusy || adminBlocked}>{t('settings.workspaces.export.discard')}</Button>
                </div>
              ) : null}
              {applyMessage ? (
                <p
                  className={cn('typography-meta', applyFailed ? 'text-[var(--status-error)]' : 'text-[var(--status-success)]')}
                  role={applyFailed ? 'alert' : 'status'}
                  data-testid="workspace-apply-message"
                >
                  {applyMessage}
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {reauth.dialog}
      <Dialog open={removeWorkspaceID !== null} onOpenChange={(open) => { if (!open && !busy) setRemoveWorkspaceID(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.workspaces.lifecycle.confirmDeleteTitle')}</DialogTitle>
            <DialogDescription>
              {`${t('settings.workspaces.lifecycle.confirmDeleteNamed', { name: removeWorkspaceName })} ${policy.preserveOnDelete ? t('settings.workspaces.lifecycle.confirmDeletePreserve') : t('settings.workspaces.lifecycle.confirmDelete')}`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter><Button variant="ghost" onClick={() => setRemoveWorkspaceID(null)} disabled={busy}>{t('settings.common.actions.cancel')}</Button><Button variant="destructive" data-testid="workspace-delete-confirm" onClick={() => void confirmRemoveWorkspace()} disabled={busy}>{t('settings.workspaces.lifecycle.delete')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={handoff !== null} onOpenChange={(open) => { if (!open && !handoffBusy) { setHandoff(null); setHandoffText(''); setHandoffError(''); } }}>
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('settings.workspaces.handoff.title')}</DialogTitle>
            <DialogDescription>{t('settings.workspaces.handoff.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-foreground">
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

function providerDisplayName(t: (key: never) => string, provider: string) {
  if (provider === 'apple-container') return t('settings.workspaces.provider.appleContainer' as never);
  if (provider === 'kubernetes') return t('settings.workspaces.provider.kubernetes' as never);
  return t('settings.workspaces.provider.docker' as never);
}

function ProviderBadge({ provider }: { provider: string }) {
  const { t } = useI18n();
  const label = provider === 'apple-container' ? t('settings.workspaces.provider.appleContainer') : provider === 'kubernetes' ? t('settings.workspaces.provider.kubernetes') : provider === 'docker' ? t('settings.workspaces.provider.docker') : provider;
  return <span className="rounded-full bg-[var(--interactive-selection)] px-2 py-0.5 typography-micro text-[var(--interactive-selection-foreground)]">{label}</span>;
}

/**
 * A workspace built under settings that have since changed. It still runs and can still
 * be deleted; what it cannot do is export under a policy it was not created with, so the
 * wording avoids calling it broken.
 */
function SettingsDriftBadge() {
  const { t } = useI18n();
  return (
    <span
      className="rounded-full bg-[var(--status-warning-background)] px-2 py-0.5 typography-micro text-foreground"
      title={t('settings.workspaces.lifecycle.driftedHint')}
    >
      {t('settings.workspaces.lifecycle.drifted')}
    </span>
  );
}

function StatusBadge({ status }: { status?: WorkspaceStatus }) {
  const { t } = useI18n();
  const key = status ? `settings.workspaces.status.${status}` as const : 'settings.workspaces.status.unknown' as const;
  return <span className={cn('rounded-full px-2 py-0.5 typography-micro', status === 'connected' ? 'bg-[var(--status-success)]/10 text-[var(--status-success)]' : status === 'error' ? 'bg-[var(--status-error)]/10 text-[var(--status-error)]' : 'bg-[var(--surface-elevated)] text-muted-foreground')}>{t(key)}</span>;
}
