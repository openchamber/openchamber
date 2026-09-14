import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  GLOBAL_IDENTITY_ID,
  isSshRemoteUrl,
  proposeIdentityForHost,
  remoteTraits,
  type RemoteTraits,
  selectableIdentities,
  identityAccountConnected,
} from '@/lib/source-control/identity';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { GitOperationResultError, runGitClone } from '@/lib/boundGitNetworkOperation';
import { PendingGitOperationError } from '@/lib/source-control/git-operation-recovery';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { useGitOperationRecovery } from '@/components/views/git/useGitOperationRecovery';
import { GitOperationStatus } from '@/components/views/git/GitOperationStatus';
import { useExistingRepositorySummary } from './useExistingRepositorySummary';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { identityTransport, isCompleteIdentity } from '@/lib/api/git-identity';
import { applyIdentityToRepository, identityApplicability, type IdentityApplicability, isSignatureOnlyIdentity, needsSystemAcknowledgement } from '@/lib/source-control/applyIdentity';
import type { GitIdentityProfile } from '@/lib/api/types';
import { useSourceControlAuthStore, useConnectedAccountIds } from '@/stores/useSourceControlAuthStore';
import { IdentityDropdown } from '@/components/views/git/GitHeader';
import { Checkbox } from '@/components/ui/checkbox';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import {
  isFilesystemError,
  type FilesystemErrorReason,
} from '@/lib/api/files-errors';

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BrowseEntry = {
  name: string;
  path: string;
};

type BrowseRow =
  | { type: 'up'; value: 'browse:up'; name: string; path: string | null; disabled?: false }
  | { type: 'directory'; value: string; name: string; path: string; disabled: boolean };

const isRootPath = (value: string): boolean => value === '/';

const normalizeSeparators = (value: string): string => value.replace(/\\/g, '/');

const trimTrailingSeparators = (value: string): string => {
  if (!value || isRootPath(value)) return value;
  let result = value;
  while (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
};

const hasTrailingPathSeparator = (value: string): boolean => value.endsWith('/');

const ensureBrowseDirectoryPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || hasTrailingPathSeparator(trimmed)) return trimmed;
  return `${trimmed}/`;
};

const getLastPathSeparatorIndex = (value: string): number => value.lastIndexOf('/');

const getBrowseDirectoryPath = (value: string): string => {
  if (hasTrailingPathSeparator(value)) return value;
  const lastSeparator = getLastPathSeparatorIndex(value);
  if (lastSeparator < 0) return value;
  return value.slice(0, lastSeparator + 1);
};

const getBrowseLeafPathSegment = (value: string): string => {
  const lastSeparator = getLastPathSeparatorIndex(value);
  return value.slice(lastSeparator + 1);
};

const getBrowseParentPath = (value: string): string | null => {
  const trimmed = trimTrailingSeparators(value.trim());
  if (!trimmed || trimmed === '~' || trimmed === '~/' || trimmed === '/') return null;
  const lastSeparator = getLastPathSeparatorIndex(trimmed);
  if (lastSeparator < 0) return null;
  if (trimmed.startsWith('~/') && lastSeparator <= 1) return '~/';
  if (lastSeparator === 0) return '/';
  return `${trimmed.slice(0, lastSeparator)}/`;
};

const canNavigateUp = (value: string): boolean => hasTrailingPathSeparator(value) && getBrowseParentPath(value) !== null;

const appendBrowsePathSegment = (currentPath: string, segment: string): string => (
  `${getBrowseDirectoryPath(currentPath)}${segment}/`
);

const normalizeDirectoryPath = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const normalized = trimTrailingSeparators(normalizeSeparators(path.trim()));
  if (!normalized) return null;
  return normalized.toLowerCase();
};

const displayPathToAbsolutePath = (value: string, homeDirectory: string): string => {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDirectory;
  if (trimmed.startsWith('~/')) {
    const rest = trimmed.slice(1);
    // Typing or pasting an absolute path while the field still holds its "~/"
    // prefix means that absolute path, not one nested under home.
    return rest.startsWith('//') ? rest.slice(1) : `${homeDirectory}${rest}`;
  }
  return trimmed;
};

const isPrimaryModifierPressed = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const focusPathInput = (input: HTMLInputElement | null): void => {
  if (!input) return;
  input.focus({ preventScroll: true });
  const valueLength = input.value.length;
  input.setSelectionRange(valueLength, valueLength);
  input.scrollLeft = input.scrollWidth;
};

const resolveFreshFilesystemHome = async (): Promise<string | null> => {
  try {
    const response = await runtimeFetch('/api/fs/home', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const data = await response.json() as { home?: unknown };
      if (typeof data.home === 'string' && data.home.trim().length > 0) {
        return normalizeSeparators(data.home.trim());
      }
    }
  } catch {
    // Fall back to the client helper below.
  }

  return opencodeClient.getFilesystemHome().catch(() => null);
};

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const { git, sourceControl, runtime } = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const openContextSurface = useUIStore((s) => s.openContextSurface);
  const mobileActions = useMobileAppActions();
  const refreshAccounts = useSourceControlAuthStore((s) => s.refreshAll);
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const projects = useProjectsStore((s) => s.projects);
  const addProject = useProjectsStore((s) => s.addProject);
  const addProjects = useProjectsStore((s) => s.addProjects);
  const [selectedPaths, setSelectedPaths] = React.useState<string[]>([]);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const gitIdentityProfiles = useGitIdentitiesStore((s) => s.profiles);
  const globalGitIdentity = useGitIdentitiesStore((s) => s.globalIdentity);
  const defaultGitIdentityId = useGitIdentitiesStore((s) => s.defaultGitIdentityId);
  const loadGitIdentityProfiles = useGitIdentitiesStore((s) => s.loadProfiles);
  const loadGlobalGitIdentity = useGitIdentitiesStore((s) => s.loadGlobalIdentity);
  const loadDefaultGitIdentityId = useGitIdentitiesStore((s) => s.loadDefaultGitIdentityId);
  const { canRequestAccess, requestAccess, startAccessing } = useFileSystemAccess();
  const { isMobile } = useDeviceInfo();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const [dialogHomeDirectory, setDialogHomeDirectory] = React.useState('');
  const [query, setQuery] = React.useState('~/');
  const [entries, setEntries] = React.useState<BrowseEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isBrowseDirectoryMissing, setIsBrowseDirectoryMissing] = React.useState(false);
  const [browseErrorReason, setBrowseErrorReason] = React.useState<FilesystemErrorReason | null>(null);
  const [browseReloadKey, setBrowseReloadKey] = React.useState(0);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [isConfirming, setIsConfirming] = React.useState(false);
  const [isOpeningFinder, setIsOpeningFinder] = React.useState(false);
  const [addButtonWidth, setAddButtonWidth] = React.useState(0);
  const [isCloneMode, setIsCloneMode] = React.useState(false);
  const [cloneRemoteUrl, setCloneRemoteUrl] = React.useState('');
  // One identity carries the account, the transport and the signature, so the
  // add and clone screens ask once instead of assembling three answers.
  const [identityChoice, setIdentityChoice] = React.useState<{ key: string; id: string } | null>(null);
  const [unverifiedConfirmed, setUnverifiedConfirmed] = React.useState(false);
  const cloneController = React.useRef<AbortController | null>(null);
  const cloneRecovery = useGitOperationRecovery(open && isCloneMode ? 'clone' : null, git, sourceControl, { kind: 'clone' });
  const [showHidden, setShowHidden] = React.useState(false);

  const explorerRootDirectory = dialogHomeDirectory || homeDirectory;

  const addedProjectPaths = React.useMemo(() => new Set(
    projects
      .map((project) => normalizeDirectoryPath(project.path))
      .filter((path): path is string => Boolean(path))
  ), [projects]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('~/');
    setEntries([]);
    setHighlightedIndex(0);
    setIsConfirming(false);
    setIsOpeningFinder(false);
    setIsCloneMode(false);
    setCloneRemoteUrl('');
    setIdentityChoice(null);
    setUnverifiedConfirmed(false);
    setSelectedPaths([]);
    setShowHidden(false);
    requestAnimationFrame(() => focusPathInput(inputRef.current));

    let cancelled = false;
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      setDialogHomeDirectory(resolved || homeDirectory || '');
      requestAnimationFrame(() => focusPathInput(inputRef.current));
    };
    void resolveHome();
    return () => {
      cancelled = true;
      cloneController.current?.abort();
    };
  }, [homeDirectory, open, runtimeKey]);

  React.useEffect(() => {
    if (open && isCloneMode && !runtime.isVSCode) void refreshAccounts(sourceControl);
  }, [open, isCloneMode, runtime.isVSCode, refreshAccounts, sourceControl, runtimeKey]);


  React.useEffect(() => {
    if (!open) return;
    void loadGitIdentityProfiles();
    void loadGlobalGitIdentity();
    void loadDefaultGitIdentityId();
  }, [loadDefaultGitIdentityId, loadGitIdentityProfiles, loadGlobalGitIdentity, open]);

  const connectedAccountIds = useConnectedAccountIds();
  const availableGitIdentities = React.useMemo(
    () => selectableIdentities(gitIdentityProfiles, globalGitIdentity,
      (identity) => (isCompleteIdentity(identity) || isSignatureOnlyIdentity(identity))
        && identityAccountConnected(identity, connectedAccountIds)),
    [gitIdentityProfiles, globalGitIdentity, connectedAccountIds],
  );


  const browseDirectoryDisplayPath = React.useMemo(() => getBrowseDirectoryPath(query), [query]);
  const browseFilterQuery = React.useMemo(
    () => (hasTrailingPathSeparator(query) ? '' : getBrowseLeafPathSegment(query)),
    [query]
  );
  const browseDirectoryAbsolutePath = React.useMemo(
    () => explorerRootDirectory ? displayPathToAbsolutePath(browseDirectoryDisplayPath, explorerRootDirectory) : '',
    [browseDirectoryDisplayPath, explorerRootDirectory]
  );

  React.useEffect(() => {
    if (!open || !browseDirectoryAbsolutePath) {
      setEntries([]);
      setBrowseErrorReason(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setIsBrowseDirectoryMissing(false);
    setBrowseErrorReason(null);
    opencodeClient.listLocalDirectory(browseDirectoryAbsolutePath)
      .then((result) => {
        if (cancelled) return;
        setIsBrowseDirectoryMissing(false);
        setBrowseErrorReason(null);
        const nextEntries = result
          .filter((entry) => entry.isDirectory)
          .map((entry) => ({
            name: entry.name,
            path: normalizeSeparators(entry.path),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        setEntries(nextEntries);
      })
      .catch((error) => {
        if (!cancelled) {
          setEntries([]);
          const reason = isFilesystemError(error) ? error.reason : 'unknown';
          setBrowseErrorReason(reason);
          setIsBrowseDirectoryMissing(reason === 'not-found');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [browseDirectoryAbsolutePath, browseReloadKey, open]);

  const filteredEntries = React.useMemo(() => {
    const lowerFilter = browseFilterQuery.toLowerCase();
    const includeHidden = showHidden || browseFilterQuery.startsWith('.');
    return entries.filter((entry) => (
      entry.name.toLowerCase().startsWith(lowerFilter) && (includeHidden || !entry.name.startsWith('.'))
    ));
  }, [browseFilterQuery, entries, showHidden]);

  const rows = React.useMemo<BrowseRow[]>(() => {
    const nextRows: BrowseRow[] = [];
    if (canNavigateUp(query)) {
      nextRows.push({ type: 'up', value: 'browse:up', name: '..', path: getBrowseParentPath(query) });
    }
    for (const entry of filteredEntries) {
      const normalized = normalizeDirectoryPath(entry.path);
      nextRows.push({
        type: 'directory',
        value: `browse:${entry.path}`,
        name: entry.name,
        path: entry.path,
        disabled: Boolean(normalized && addedProjectPaths.has(normalized)),
      });
    }
    return nextRows;
  }, [addedProjectPaths, filteredEntries, query]);

  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [query, rows.length]);

  const targetPath = React.useMemo(() => {
    if (!explorerRootDirectory) return '';
    return trimTrailingSeparators(displayPathToAbsolutePath(query, explorerRootDirectory));
  }, [explorerRootDirectory, query]);
  // Selections apply to the currently browsed directory: navigating into
  // another folder clears the pending batch so the primary action always
  // reflects the visible picker state.
  React.useEffect(() => {
    setSelectedPaths([]);
  }, [browseDirectoryAbsolutePath]);
  const selectionPaths = React.useMemo(
    () => selectedPaths.filter((path) => {
      const normalized = normalizeDirectoryPath(path);
      return Boolean(normalized && !addedProjectPaths.has(normalized));
    }),
    [addedProjectPaths, selectedPaths]
  );
  const togglePathSelection = React.useCallback((path: string) => {
    setSelectedPaths((prev) => (
      prev.includes(path) ? prev.filter((entry) => entry !== path) : [...prev, path]
    ));
  }, []);

  const normalizedTargetPath = normalizeDirectoryPath(targetPath);
  const isAlreadyAdded = Boolean(normalizedTargetPath && addedProjectPaths.has(normalizedTargetPath));
  const exactEntry = React.useMemo(() => {
    if (!browseFilterQuery) return null;
    return filteredEntries.find((entry) => entry.name === browseFilterQuery) ?? null;
  }, [browseFilterQuery, filteredEntries]);
  const shouldCreateTarget = Boolean(
    targetPath
    && !isAlreadyAdded
    && (browseErrorReason === null || browseErrorReason === 'not-found')
    && (
      (hasTrailingPathSeparator(query) && isBrowseDirectoryMissing)
      || (!hasTrailingPathSeparator(query) && browseFilterQuery.trim().length > 0 && exactEntry === null)
    )
  );
  const canAddProject = !isConfirming
    && !isOpeningFinder
    && browseErrorReason !== 'os-permission'
    && browseErrorReason !== 'invalid-response'
    && browseErrorReason !== 'unknown'
    && ((!isCloneMode && selectionPaths.length > 0) || (!isAlreadyAdded && Boolean(targetPath)));
  // Adding a directory that is already a repository: read what its own .git
  // states so the association can be offered instead of asked for. Nothing is
  // written until the project is added with the proposal still selected.
  const existingRepository = useExistingRepositorySummary(targetPath, { sourceControl, git },
    !isCloneMode && !runtime.isVSCode && !isAlreadyAdded && !shouldCreateTarget && selectionPaths.length === 0);
  React.useEffect(() => {
    if (existingRepository && !runtime.isVSCode) void refreshAccounts(sourceControl);
  }, [existingRepository, refreshAccounts, runtime.isVSCode, runtimeKey, sourceControl]);

  /**
   * The identity this screen is about to apply.
   *
   * It is proposed from the host the repository points at, so a repository on a
   * host one identity already answers for needs no choice at all, and stays
   * whatever the person picks instead. The key carries the host so a new host
   * proposes again rather than keeping an answer given for another one.
   */
  const existingPrimaryRemote = existingRepository?.primaryRemote ?? null;
  const identityRemote = React.useMemo((): RemoteTraits | null => {
    if (isCloneMode) return cloneRemoteUrl.trim() ? remoteTraits(cloneRemoteUrl) : null;
    if (!existingPrimaryRemote) return null;
    return { host: existingPrimaryRemote.host, https: existingPrimaryRemote.https, ssh: existingPrimaryRemote.ssh };
  }, [isCloneMode, cloneRemoteUrl, existingPrimaryRemote]);
  const identityHost = identityRemote?.host ?? null;
  const identityChoiceKey = `${isCloneMode ? 'clone' : 'add'}:${identityHost ?? ''}`;
  // An identity is specific to an instance and to a way of reaching it; one
  // that cannot serve this remote is shown with the reason, never proposed.
  const identityApplicabilityOf = React.useCallback((identity: GitIdentityProfile): IdentityApplicability =>
    identityRemote ? identityApplicability(identity, identityRemote) : { applicable: true },
  [identityRemote]);
  const existingAuthor = existingRepository?.author ?? null;
  const proposedIdentity = React.useMemo(() => {
    const applicable = availableGitIdentities.filter((identity) => identityApplicabilityOf(identity).applicable);
    // A repository already signed as one of the identities is proposed as that
    // identity: it says what the repository is, before any host can guess.
    const signedAs = existingAuthor
      ? applicable.find((identity) => identity.userName === existingAuthor.userName
        && identity.userEmail === existingAuthor.userEmail)
      : undefined;
    return signedAs ?? proposeIdentityForHost(applicable, identityHost, defaultGitIdentityId);
  }, [availableGitIdentities, defaultGitIdentityId, existingAuthor, identityApplicabilityOf, identityHost]);
  const selectedGitIdentity = React.useMemo(() => {
    const chosen = identityChoice?.key === identityChoiceKey
      ? availableGitIdentities.find((identity) => identity.id === identityChoice.id)
      : null;
    return chosen ?? proposedIdentity;
  }, [availableGitIdentities, identityChoice, identityChoiceKey, proposedIdentity]);
  // Confirming System Git is about credentials a transfer would use, so it is
  // asked only when there is a remote to bind: a clone always has one, and a
  // local-only repository has none and binds nothing.
  const identityNeedsAcknowledgement = Boolean(selectedGitIdentity && needsSystemAcknowledgement(
    selectedGitIdentity, isCloneMode || Boolean(existingRepository?.primaryRemote),
  ));
  /**
   * How the clone authenticates, read off the identity.
   *
   * Null means the identity cannot serve this URL — an account or anonymous
   * identity for an SSH address, a key for an HTTPS one — which is a mismatch
   * to show rather than a transfer to attempt.
   */
  const cloneSelection: Parameters<typeof runGitClone>[0]['selection'] | null = React.useMemo(() => {
    if (!selectedGitIdentity) return null;
    const https = cloneRemoteUrl.trim().startsWith('https://');
    const transport = identityTransport(selectedGitIdentity);
    if (transport === 'account' && selectedGitIdentity.account && https) {
      return { transportMode: 'managed', credentialAccount: selectedGitIdentity.account };
    }
    if (transport === 'ssh' && selectedGitIdentity.sshCredentialId && isSshRemoteUrl(cloneRemoteUrl)) {
      return { transportMode: 'managed', sshCredentialId: selectedGitIdentity.sshCredentialId };
    }
    if (transport === 'anonymous' && https) return { transportMode: 'anonymous' };
    if (transport === 'system' && unverifiedConfirmed) return { transportMode: 'system', unverifiedConfirmed: true };
    return null;
  }, [cloneRemoteUrl, selectedGitIdentity, unverifiedConfirmed]);

  const canSubmitClone = canAddProject && !runtime.isVSCode && !cloneRecovery.blocked && cloneRemoteUrl.trim().length > 0
    && Boolean(cloneSelection) && (!identityNeedsAcknowledgement || unverifiedConfirmed);
  const highlightedRow = rows[highlightedIndex] ?? null;
  const hasHighlightedBrowseItem = Boolean(
    highlightedRow && (highlightedRow.type === 'up' || highlightedRow.type === 'directory')
  );
  const submitModifierLabel = formatShortcutForDisplay('mod');
  const submitActionLabel = !isCloneMode && selectionPaths.length > 0
    ? t('directoryExplorerDialog.actions.addSelected')
    : isAlreadyAdded
    ? t('directoryExplorerDialog.actions.alreadyAdded')
    : isCloneMode
      ? isConfirming
        ? t('directoryExplorerDialog.actions.cloning')
        : t('directoryExplorerDialog.actions.cloneAndAdd')
    : isConfirming
      ? t('directoryExplorerDialog.actions.adding')
    : shouldCreateTarget
      ? t('directoryExplorerDialog.actions.createAndAdd')
      : t('directoryExplorerDialog.actions.addProject');

  React.useLayoutEffect(() => {
    const button = addButtonRef.current;
    if (!button) return;

    const updateWidth = () => setAddButtonWidth(Math.ceil(button.getBoundingClientRect().width));
    updateWidth();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(button);
    return () => observer.disconnect();
  }, [submitActionLabel]);

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.scrollLeft = input.scrollWidth;
  }, [addButtonWidth, query]);

  React.useLayoutEffect(() => {
    if (!open) return;
    focusPathInput(inputRef.current);
  }, [open]);

  React.useLayoutEffect(() => {
    const row = rows[highlightedIndex];
    if (!row) return;
    rowRefs.current.get(row.value)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, rows]);

  const handleClose = React.useCallback(() => {
    cloneController.current?.abort();
    onOpenChange(false);
  }, [onOpenChange]);

  const openProjectDraft = React.useCallback((projectId: string, projectPath: string) => {
    if (isMobile) setSessionSwitcherOpen(false);
    openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: projectPath });
    handleClose();
  }, [handleClose, isMobile, openNewSessionDraft, setSessionSwitcherOpen]);

  const handleQuickAdd = React.useCallback(async (event: React.MouseEvent, path: string) => {
    event.stopPropagation();
    const normalized = normalizeDirectoryPath(path);
    if (normalized && addedProjectPaths.has(normalized)) return;
    const project = await addProject(path);
    if (!project) {
      toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
        description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
      });
      return;
    }
    openProjectDraft(project.id, project.path);
  }, [addProject, addedProjectPaths, openProjectDraft, t]);

  const finalizeSelection = React.useCallback(async (target: string) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (isConfirming) return;
    if (isCloneMode && (!canSubmitClone || cloneController.current)) return;
    const capturedRuntime = runtimeKey;
    const normalized = normalizeDirectoryPath(target);
    // Batch selections supersede the single-target flow. Only the single-target
    // flow is blocked by an already-added (or missing) directory.
    const selectionToAdd = isCloneMode
      ? []
      : selectedPaths.filter((path) => {
        const selectionNormalized = normalizeDirectoryPath(path);
        return Boolean(selectionNormalized && !addedProjectPaths.has(selectionNormalized));
      });
    if (selectionToAdd.length === 0 && (!target || (normalized && addedProjectPaths.has(normalized)))) return;
    let selectedTarget = target;
    let setupRequired = false;

    setIsConfirming(true);
    try {
      const shouldCreateSelection = !isCloneMode && shouldCreateTarget && normalizeDirectoryPath(target) === normalizeDirectoryPath(targetPath);
      if (isCloneMode) {
        const remoteUrl = cloneRemoteUrl.trim();
        if (!remoteUrl) {
          toast.error(t('directoryExplorerDialog.toast.cloneUrlRequired'));
          return;
        }
        const selection = cloneSelection;
        if (!selection) return;
        const recovery = cloneRecovery.start();
        if (!recovery) return;
        const controller = new AbortController();
        cloneController.current = controller;
        const result = await runGitClone({
          remoteUrl,
          destinationPath: target,
          // The System identity writes no author: it is the absence of an
          // override, and the machine may not even have one to copy.
          gitIdentityId: selectedGitIdentity && selectedGitIdentity.id !== GLOBAL_IDENTITY_ID
            ? selectedGitIdentity.id : undefined,
          providerAccount: selectedGitIdentity?.account ?? undefined,
          git,
          selection,
          signal: controller.signal,
          onOperation: recovery.onOperation,
        }).finally(recovery.finish);
        if (result.status === 'cancelled') return;
        setupRequired = result.status === 'setup-required';
        selectedTarget = target;
        // The clone's credential grant reaches Git in agent shells only once
        // the managed OpenCode child restarts with its host in the environment.
        const cloneTransport = identityTransport(selectedGitIdentity);
        if (remoteUrl.trim().startsWith('https://') && (cloneTransport === 'account' || cloneTransport === 'system')) {
          recordDeferredOpenCodeRestart('cli', { id: `agent-git:${target}` });
        }
      } else if (selectionToAdd.length > 0) {
        // Batch path wins over single-target create: with checkboxes ticked,
        // the user wants the selections added, not a fresh directory created
        // for whatever happens to be typed in the filter.
        const added = await addProjects(selectionToAdd);
        if (added.length === 0) {
          toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
            description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
          });
          return;
        }
        toast.success(t('directoryExplorerDialog.toast.addedProjects', { count: added.length }));
        setSelectedPaths([]);
        handleClose();
        return;
      } else if (shouldCreateSelection) {
        await opencodeClient.createDirectory(target, { asProject: true });
      }
      if (capturedRuntime !== getRuntimeKey()) return;
      const project = await addProject(selectedTarget);
      if (!project) {
        toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
          description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
        });
        return;
      }
      // A System identity proposed by default describes the repository as it
      // is; it is written only when the person chose it or confirmed its
      // credentials, so adding a directory never clears an author on its own.
      const identityChosen = identityChoice?.key === identityChoiceKey;
      const applyIdentity = selectedGitIdentity
        && (identityChosen || selectedGitIdentity.id !== GLOBAL_IDENTITY_ID || unverifiedConfirmed);
      if (!isCloneMode && applyIdentity && existingRepository
        && existingRepository.directory === selectedTarget) {
        const outcome = await applyIdentityToRepository({
          directory: project.path,
          // A repository with no remote binds nothing; the identity is still
          // written, because it also says who commits there.
          remoteName: existingRepository.primaryRemote?.name ?? null,
          identity: selectedGitIdentity,
          acknowledgedSystem: unverifiedConfirmed,
        }, { git, sourceControl });
        // The project is added either way; what could not be written is said
        // here rather than swallowed, and the Git panel can finish it.
        if (outcome.status === 'failed') toast.warning(t('directoryExplorerDialog.existing.bindFailed'));
      }
      openProjectDraft(project.id, project.path);
      if (setupRequired) {
        if (mobileActions) mobileActions.openChanges();
        else openContextSurface(project.path, 'git');
        toast.warning(t('directoryExplorerDialog.clone.setupRequired'));
      }
    } catch (error) {
      if (capturedRuntime !== getRuntimeKey()) return;
      if (error instanceof GitOperationResultError || error instanceof PendingGitOperationError) return;
      toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
        description: error instanceof Error ? error.message : t('directoryExplorerDialog.toast.unknownError'),
      });
    } finally {
      cloneController.current = null;
      setIsConfirming(false);
    }
  }, [addProject, addProjects, addedProjectPaths, canSubmitClone, cloneRecovery, cloneSelection, identityChoice, identityChoiceKey, unverifiedConfirmed, cloneRemoteUrl, existingRepository, git, handleClose, isCloneMode, isConfirming, mobileActions, openContextSurface, openProjectDraft, runtimeKey, selectedGitIdentity, selectedPaths, shouldCreateTarget, sourceControl, targetPath, t]);

  const browseToDisplayPath = React.useCallback((displayPath: string) => {
    setQuery(ensureBrowseDirectoryPath(displayPath));
  }, []);

  const browseToEntry = React.useCallback((entry: BrowseEntry) => {
    setQuery(appendBrowsePathSegment(query, entry.name));
  }, [query]);

  const executeRow = React.useCallback((row: BrowseRow | null) => {
    if (!row) return;
    if (row.type === 'up') {
      if (row.path) browseToDisplayPath(row.path);
      return;
    }
    if (row.disabled) return;
    browseToEntry(row);
  }, [browseToDisplayPath, browseToEntry]);

  const handleOpenInFinder = React.useCallback(async () => {
    if (!canRequestAccess || isOpeningFinder) return;
    setIsOpeningFinder(true);
    try {
      const result = await requestAccess(targetPath);
      if (!result.success || !result.path) {
        if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
            description: result.error,
          });
        }
        return;
      }

      const accessResult = await startAccessing(result.path);
      if (!accessResult.success) {
        toast.error(t('directoryExplorerDialog.toast.failedToOpenDirectory'), {
          description: accessResult.error || t('directoryExplorerDialog.toast.desktopCouldNotGrantAccess'),
        });
        return;
      }

      await finalizeSelection(result.path);
    } catch (error) {
      toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
        description: error instanceof Error ? error.message : t('directoryExplorerDialog.toast.unknownError'),
      });
    } finally {
      setIsOpeningFinder(false);
    }
  }, [canRequestAccess, finalizeSelection, isOpeningFinder, requestAccess, startAccessing, t, targetPath]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(rows.length - 1, index + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === ' ') {
      // Only treat Space as a selection toggle when the user is actively
      // browsing a directory (trailing slash or no filter typing). When
      // the input is in path-entry mode, Space is a literal character
      // and must reach the input value.
      if (hasTrailingPathSeparator(query)) {
        event.preventDefault();
        if (highlightedRow && highlightedRow.type === 'directory' && !highlightedRow.disabled) {
          togglePathSelection(highlightedRow.path);
        }
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isPrimaryModifierPressed(event)) {
        void finalizeSelection(targetPath);
        return;
      }
      if (hasHighlightedBrowseItem) {
        executeRow(highlightedRow);
      }
      return;
    }
    if (event.key === 'Backspace' && query === '') {
      event.preventDefault();
      handleClose();
    }
  }, [executeRow, finalizeSelection, handleClose, hasHighlightedBrowseItem, highlightedRow, query, rows.length, targetPath, togglePathSelection]);

  const showHiddenToggle = (
    <button
      type="button"
      onClick={() => setShowHidden((value) => !value)}
      className="flex flex-shrink-0 items-center gap-2 rounded-lg px-2 py-1 typography-meta text-muted-foreground transition-colors hover:bg-interactive-hover/40"
    >
      {showHidden ? <Icon name="checkbox" className="h-4 w-4 text-primary" /> : <Icon name="checkbox-blank" className="h-4 w-4" />}
      {t('directoryExplorerDialog.toggle.showHidden')}
    </button>
  );

  /**
   * One control for the three answers a repository needs.
   *
   * The identity says whose account it is, how transfers authenticate and who
   * commits, so the screen names the configuration rather than asking for its
   * parts. System Git still asks: it is a decision about trusting whatever the
   * machine holds, and choosing an identity is not the same as saying that.
   */
  const identityPicker = availableGitIdentities.length ? (
    <>
      <IdentityDropdown
        activeProfile={selectedGitIdentity ?? null}
        identities={availableGitIdentities}
        onSelect={(identity) => {
          setIdentityChoice({ key: identityChoiceKey, id: identity.id });
          setUnverifiedConfirmed(false);
        }}
        isApplying={isConfirming}
        applicability={identityApplicabilityOf}
        triggerClassName="w-full max-w-none border border-border"
        menuAlign="start"
      />
      {identityNeedsAcknowledgement ? (
        <label className="flex items-start gap-2 typography-micro text-muted-foreground">
          <Checkbox checked={unverifiedConfirmed} onChange={setUnverifiedConfirmed} disabled={isConfirming}
            ariaLabel={t('settings.sourceControl.transport.unverifiedConfirmation')} />
          {t('settings.sourceControl.transport.unverifiedConfirmation')}
        </label>
      ) : null}
      {isCloneMode && selectedGitIdentity && !cloneSelection && !identityNeedsAcknowledgement ? (
        <p className="typography-micro text-muted-foreground">{t('directoryExplorerDialog.clone.identityMismatch')}</p>
      ) : null}
    </>
  ) : null;

  const inputSection = (
    <div className="px-2.5 py-1.5">
      {!isCloneMode && existingRepository ? (
        <div className="mb-1.5 space-y-1.5">
          {identityPicker}
        </div>
      ) : null}
      {isCloneMode ? (
        <div className="mb-1.5 space-y-1.5">
          <GitOperationStatus entry={cloneRecovery.entry} onRefresh={() => void cloneRecovery.refresh()} onCancel={() => void cloneRecovery.cancel()} />
          <div className="flex items-center gap-1.5">
            <Input
              value={cloneRemoteUrl}
              disabled={isConfirming}
              onChange={(event) => {
                setCloneRemoteUrl(event.target.value);
                setUnverifiedConfirmed(false);
              }}
              placeholder={t('directoryExplorerDialog.clone.remoteUrlPlaceholder')}
              aria-label={t('directoryExplorerDialog.clone.remoteUrlPlaceholder')}
              className="min-w-0 flex-1 border-border/60 bg-[var(--surface-elevated)] font-mono typography-ui-label shadow-none"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>
          {identityPicker}
          {runtime.isVSCode ? <p className="typography-micro text-muted-foreground">{t('directoryExplorerDialog.clone.unsupported')}</p> : null}
        </div>
      ) : null}
      <div className="relative">
        <Icon name="folder-add" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80" />
        <Input
          ref={inputRef}
          value={query}
          disabled={isConfirming}
          onChange={(event) => setQuery(normalizeSeparators(event.target.value))}
          onKeyDown={handleKeyDown}
          placeholder={t('directoryExplorerDialog.pathInput.placeholder')}
          className="border-transparent bg-transparent pl-9 font-mono typography-ui-label shadow-none focus-visible:ring-0"
          style={!isMobile && addButtonWidth > 0 ? { paddingRight: `${addButtonWidth + 24}px` } : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        {!isMobile ? (
          <Button
            ref={addButtonRef}
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="absolute right-1.5 top-1/2 h-7 -translate-y-1/2 gap-1 px-2 typography-meta"
            disabled={isCloneMode ? !canSubmitClone : !canAddProject}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void finalizeSelection(targetPath)}
            title={submitActionLabel}
          >
            {submitActionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );

  const resultsSection = (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)] shadow-sm">
      <ScrollableOverlay outerClassName="max-h-[min(28rem,58vh)]" className="p-2">
        <div className="px-2 pb-1 pt-0.5 typography-meta font-medium uppercase tracking-wide text-muted-foreground/80">
          {t('directoryExplorerDialog.browse.directories')}
        </div>
        {isLoading ? (
          <div className="py-10 text-center typography-ui-label text-muted-foreground">
            {t('directoryExplorerDialog.browse.loading')}
          </div>
        ) : browseErrorReason && browseErrorReason !== 'not-found' ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <div className="typography-ui-label text-status-error">
              {browseErrorReason === 'os-permission'
                ? t('directoryExplorerDialog.browse.permissionDenied')
                : t('directoryExplorerDialog.browse.loadFailed')}
            </div>
            <div className="flex items-center gap-2">
              {browseErrorReason === 'os-permission' && canRequestAccess ? (
                <Button size="xs" onClick={() => void handleOpenInFinder()} disabled={isOpeningFinder}>
                  {t('directoryExplorerDialog.browse.grantAccess')}
                </Button>
              ) : null}
              <Button variant="outline" size="xs" onClick={() => setBrowseReloadKey((key) => key + 1)}>
                {t('directoryExplorerDialog.browse.retry')}
              </Button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center typography-ui-label text-muted-foreground">
            {t('directoryExplorerDialog.browse.empty')}
          </div>
        ) : (
          <div className="space-y-0.5">
            {rows.map((row, index) => {
              const isActive = index === highlightedIndex;
              return (
                <button
                  key={row.value}
                  ref={(node) => {
                    if (node) {
                      rowRefs.current.set(row.value, node);
                    } else {
                      rowRefs.current.delete(row.value);
                    }
                  }}
                  type="button"

                  onMouseEnter={() => setHighlightedIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => executeRow(row)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    isActive && 'bg-interactive-selection text-interactive-selection-foreground',
                    !isActive && 'hover:bg-interactive-hover/50',
                    row.type === 'directory' && row.disabled && 'opacity-45'
                  )}
                >
                  {row.type === 'up' ? (
                    <Icon name="arrow-left-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                  ) : (
                    <Icon name="folder-6" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                  )}
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate typography-ui-label text-foreground">{row.name}</span>
                  </span>
                  {row.type === 'directory' && row.disabled ? (
                    <span className="rounded-full border border-border/60 px-2 py-0.5 typography-meta text-muted-foreground">
                      {t('directoryExplorerDialog.browse.addedBadge')}
                    </span>
                  ) : row.type === 'directory' ? (
                    <>
                      <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => { event.stopPropagation(); togglePathSelection(row.path); }}
                        title={t('directoryExplorerDialog.browse.selectForAdd')}
                        aria-label={t('directoryExplorerDialog.browse.selectForAdd')}
                        aria-pressed={selectedPaths.includes(row.path)}
                        className="flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                      >
                        <Icon name={selectedPaths.includes(row.path) ? 'checkbox' : 'checkbox-blank'} className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => handleQuickAdd(event, row.path)}
                        className="flex-shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                        title={t('directoryExplorerDialog.browse.quickAdd')}
                      >
                        <Icon name="add" className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </ScrollableOverlay>
    </div>
  );

  const content = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {inputSection}
      {resultsSection}
    </div>
  );

  const footerHints = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
        <Icon name="arrow-down-s" className="-ml-1 h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.navigate')}
      </span>
      <span className="inline-flex items-center gap-1">
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.select')}
      </span>
      <span className="inline-flex items-center gap-1">
        <span>{submitModifierLabel}</span>
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.add')}
      </span>
    </div>
  );

  const renderFooter = () => (
    <>
      {!isMobile ? footerHints : null}
      <div className={cn('flex w-full flex-row justify-end gap-2 sm:w-auto', isMobile && 'justify-stretch')}>
        {canRequestAccess ? (
          <Button variant="ghost" size="xs" onClick={handleOpenInFinder} disabled={isConfirming || isOpeningFinder || isCloneMode}>
            {isOpeningFinder ? t('directoryExplorerDialog.actions.openingFinder') : t('directoryExplorerDialog.actions.openInFinder')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => { setIsCloneMode((value) => !value); setSelectedPaths([]); }}
          disabled={isConfirming || isOpeningFinder}
          className={cn(isMobile && 'flex-1')}
        >
          {isCloneMode ? t('directoryExplorerDialog.actions.addLocalProject') : t('directoryExplorerDialog.actions.cloneRepository')}
        </Button>
        {isMobile ? (
          <Button size="xs" onClick={() => void finalizeSelection(targetPath)} disabled={isCloneMode ? !canSubmitClone : !canAddProject} className="flex-1">
            {submitActionLabel}
          </Button>
        ) : null}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={handleClose}
        title={t('directoryExplorerDialog.title')}
        // Height only — the width stays on MobileOverlayPanel's shared max-w-lg
        // so this sheet matches every other mobile overlay on wide screens.
        className="h-[88dvh] max-h-[720px]"
        contentMaxHeightClassName="flex-1"
        footer={<div className="flex flex-col gap-2">{renderFooter()}</div>}
      >
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex justify-end">{showHiddenToggle}</div>
          {content}
        </div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(value) => value ? onOpenChange(true) : handleClose()}>
      <DialogContent
        className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[80vh]"
        initialFocus={false}
      >
        <DialogHeader className="px-5 pb-2 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle>{t('directoryExplorerDialog.title')}</DialogTitle>
              <DialogDescription className="mt-2">{t('directoryExplorerDialog.description')}</DialogDescription>
            </div>
            {showHiddenToggle}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 px-2 pb-0">{content}</div>
        <DialogFooter className="flex w-full flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          {renderFooter()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
