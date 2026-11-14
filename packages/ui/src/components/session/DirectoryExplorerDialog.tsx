import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  GLOBAL_IDENTITY_ID,
  activeIdentityFor,
  isSshRemoteUrl,
  proposeIdentityForHost,
  instanceSshHostsFrom,
  remoteTraits,
  type RemoteTraits,
  selectableIdentities,
  identityAccountConnected,
} from '@/lib/source-control/identity';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { GitOperationResultError, runGitClone } from '@/lib/boundGitNetworkOperation';
import { PendingGitOperationError } from '@/lib/source-control/git-operation-recovery';
import { useGitOperationRecovery } from '@/components/views/git/useGitOperationRecovery';
import { GitOperationStatus } from '@/components/views/git/GitOperationStatus';
import { useExistingRepositorySummary } from './useExistingRepositorySummary';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { identityTransport, isCompleteIdentity } from '@/lib/api/git-identity';
import { applyIdentityToRepository, identityApplicability, type IdentityApplicability } from '@/lib/source-control/applyIdentity';
import type { GitIdentityProfile } from '@/lib/api/types';
import { useSourceControlAuthStore, useConnectedAccountIds } from '@/stores/useSourceControlAuthStore';
import { IdentityDropdown } from '@/components/views/git/GitHeader';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getBrowseParentPath, initialBrowseQuery, isRootedBrowseQuery, projectBrowsePlaces, resolveBrowseQuery, trimTrailingSeparators } from './directoryExplorerStart';
import { getDirectoryPickerLabelKey } from './directoryExplorerLabels';
import { useOpenCodeProjects } from './project-import/useOpenCodeProjects';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { cn, formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatProjectLabel } from './sidebar/utils';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDeviceInfo } from '@/lib/device';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { opencodeClient } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import {
  isFilesystemError,
  type FilesystemErrorReason,
} from '@/lib/api/files-errors';

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Takes over from opening a new session draft in the added project. Picks one folder at a time. */
  onProjectAdded?: (project: { id: string; path: string }) => void;
}

type BrowseEntry = {
  name: string;
  path: string;
};

// An added folder can still be browsed for its subfolders; only adding it again is blocked.
// A link to an added project names that project and where it really is.
type BrowseRow = {
  value: string;
  name: string;
  path: string;
  added: boolean;
  linkTarget: { label: string; path: string } | null;
};

type ExplorerView = 'folder' | 'opencode' | 'clone';

const LOADING_MESSAGE_DELAY_MS = 200;

const normalizeSeparators = (value: string): string => value.replace(/\\/g, '/');

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

const lastPathSegment = (value: string): string => {
  const trimmed = trimTrailingSeparators(value);
  return trimmed.slice(getLastPathSeparatorIndex(trimmed) + 1) || trimmed;
};

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

// The folder name `git clone` gives a checkout: the URL's last segment without `.git`.
const cloneDirectoryName = (remoteUrl: string): string => {
  const withoutQuery = remoteUrl.trim().split(/[?#]/, 1)[0] ?? '';
  const name = withoutQuery.match(/([^/:]+?)(?:\.git)?\/?$/)?.[1]?.trim() ?? '';
  return name === '.' || name === '..' ? '' : name;
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
  onProjectAdded,
}) => {
  const { t } = useI18n();
  const { git, sourceControl, runtime } = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const openContextSurface = useUIStore((s) => s.openContextSurface);
  const mobileActions = useMobileAppActions();
  const refreshAccounts = useSourceControlAuthStore((s) => s.refreshAll);
  const sourceControlIdentities = useSourceControlAuthStore((s) => s.identities);
  const instanceSshHosts = React.useMemo(() => instanceSshHostsFrom(sourceControlIdentities), [sourceControlIdentities]);
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
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const [dialogHomeDirectory, setDialogHomeDirectory] = React.useState('');
  const [query, setQuery] = React.useState('~/');
  const [browsedFolder, setBrowsedFolder] = React.useState('~/');
  const [entries, setEntries] = React.useState<BrowseEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingSlowly, setIsLoadingSlowly] = React.useState(false);
  const [isBrowseDirectoryMissing, setIsBrowseDirectoryMissing] = React.useState(false);
  const [browseErrorReason, setBrowseErrorReason] = React.useState<FilesystemErrorReason | null>(null);
  const [browseReloadKey, setBrowseReloadKey] = React.useState(0);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [isAddingProject, setIsAddingProject] = React.useState(false);
  const isConfirming = isAddingProject;
  const [isOpeningFinder, setIsOpeningFinder] = React.useState(false);
  const [requestedView, setRequestedView] = React.useState<ExplorerView>('folder');
  const [cloneRemoteUrl, setCloneRemoteUrl] = React.useState('');
  // One identity carries the account, the transport and the signature, so the
  // add and clone screens ask once instead of assembling three answers.
  const [identityChoice, setIdentityChoice] = React.useState<{ key: string; id: string } | null>(null);
  const cloneController = React.useRef<AbortController | null>(null);
  const openCodeProjects = useOpenCodeProjects(open && !runtime.isVSCode && !onProjectAdded, runtimeKey);
  // The OpenCode list can be gone by the time a view of it would show.
  const view = requestedView === 'opencode' && openCodeProjects.length === 0 ? 'folder' : requestedView;
  const isCloneMode = view === 'clone';
  const isOpenCodeView = view === 'opencode';
  // A single-folder flow never selects; the clone destination is the path field.
  const canSelect = !onProjectAdded && !isCloneMode;
  const cloneRecovery = useGitOperationRecovery(open && isCloneMode ? 'clone' : null, git, sourceControl, { kind: 'clone' });
  const [showHidden, setShowHidden] = React.useState(false);

  const explorerRootDirectory = dialogHomeDirectory || homeDirectory;

  const addedProjectsByPath = React.useMemo(() => {
    const byPath = new Map<string, (typeof projects)[number]>();
    for (const project of projects) {
      const normalized = normalizeDirectoryPath(project.path);
      if (normalized) byPath.set(normalized, project);
    }
    return byPath;
  }, [projects]);
  // Settings keep a project under its real path, so a folder that links to an
  // added project is that project and adding it again would add nothing.
  // Keyed by the normalized folder path; filled as folders are listed.
  const [realPaths, setRealPaths] = React.useState<ReadonlyMap<string, string>>(new Map());
  const addedProjectOf = React.useCallback((path: string) => {
    const normalized = normalizeDirectoryPath(path);
    if (!normalized) return null;
    const own = addedProjectsByPath.get(normalized);
    if (own) return own;
    const real = normalizeDirectoryPath(realPaths.get(normalized));
    return (real && addedProjectsByPath.get(real)) || null;
  }, [addedProjectsByPath, realPaths]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('~/');
    setBrowsedFolder('~/');
    setEntries([]);
    setHighlightedIndex(0);
    setIsAddingProject(false);
    setIsOpeningFinder(false);
    setRequestedView('folder');
    setCloneRemoteUrl('');
    setIdentityChoice(null);
    setSelectedPaths([]);
    setShowHidden(false);
    setRealPaths(new Map());

    let cancelled = false;
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      const home = resolved || homeDirectory || '';
      setDialogHomeDirectory(home);
      // Only while the field still holds the untouched default.
      const start = initialBrowseQuery(useProjectsStore.getState().projects, home);
      setQuery((current) => (current === '~/' ? start : current));
    };
    void resolveHome();
    return () => {
      cancelled = true;
      cloneController.current?.abort();
    };
  }, [homeDirectory, open, runtimeKey]);

  React.useEffect(() => {
    if (open && isCloneMode) void refreshAccounts(sourceControl);
  }, [open, isCloneMode, refreshAccounts, sourceControl, runtimeKey]);


  React.useEffect(() => {
    if (!open) return;
    void loadGitIdentityProfiles();
    void loadGlobalGitIdentity();
    void loadDefaultGitIdentityId();
  }, [loadDefaultGitIdentityId, loadGitIdentityProfiles, loadGlobalGitIdentity, open]);

  const connectedAccountIds = useConnectedAccountIds();
  const availableGitIdentities = React.useMemo(
    () => selectableIdentities(gitIdentityProfiles, globalGitIdentity,
      (identity) => isCompleteIdentity(identity)
        && identityAccountConnected(identity, connectedAccountIds)),
    [gitIdentityProfiles, globalGitIdentity, connectedAccountIds],
  );


  // The last folder the field pointed at, which a rail entry stays selected for
  // while the field is cleared or holds a bare name.
  React.useEffect(() => {
    if (isRootedBrowseQuery(query) && query.includes('/')) setBrowsedFolder(getBrowseDirectoryPath(query));
  }, [query]);
  const resolvedQuery = React.useMemo(() => resolveBrowseQuery(query, browsedFolder), [browsedFolder, query]);
  const browseDirectoryDisplayPath = React.useMemo(() => getBrowseDirectoryPath(resolvedQuery), [resolvedQuery]);
  const browseFilterQuery = React.useMemo(
    () => (hasTrailingPathSeparator(resolvedQuery) ? '' : getBrowseLeafPathSegment(resolvedQuery)),
    [resolvedQuery]
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
    // A listing usually arrives within a frame or two. The previous rows stay
    // until then, so switching folders does not flash a loading line.
    const slowLoading = setTimeout(() => setIsLoadingSlowly(true), LOADING_MESSAGE_DELAY_MS);
    setIsBrowseDirectoryMissing(false);
    setBrowseErrorReason(null);
    opencodeClient.listLocalDirectory(browseDirectoryAbsolutePath)
      .then(async (result) => {
        if (cancelled) return;
        const nextEntries = result
          .filter((entry) => entry.isDirectory)
          .map((entry) => ({
            name: entry.name,
            path: normalizeSeparators(entry.path),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        // With the rows, so a link never shows as addable first. The folder
        // itself is resolved too: the path field can point at it.
        const resolved = await opencodeClient.getDirectoryRealPaths([
          browseDirectoryAbsolutePath,
          ...nextEntries.map((entry) => entry.path),
        ]);
        if (cancelled) return;
        setIsBrowseDirectoryMissing(false);
        setBrowseErrorReason(null);
        setRealPaths((current) => {
          const next = new Map(current);
          for (const [path, realPath] of resolved) {
            const normalized = normalizeDirectoryPath(path);
            if (normalized) next.set(normalized, realPath);
          }
          return next;
        });
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
        clearTimeout(slowLoading);
        if (cancelled) return;
        setIsLoading(false);
        setIsLoadingSlowly(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(slowLoading);
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
    // A folder is a link when it is not where its parent really is: a link
    // further up (a linked home folder) moves every row and marks none.
    const folderRealPath = realPaths.get(normalizeDirectoryPath(browseDirectoryAbsolutePath) ?? '');
    return filteredEntries.map((entry) => {
      const project = addedProjectOf(entry.path);
      const unlinkedPath = !folderRealPath ? entry.path
        : folderRealPath.endsWith('/') ? `${folderRealPath}${entry.name}`
          : `${trimTrailingSeparators(folderRealPath)}/${entry.name}`;
      const isLink = project !== null && normalizeDirectoryPath(project.path) !== normalizeDirectoryPath(unlinkedPath);
      return {
        value: `browse:${entry.path}`,
        name: entry.name,
        path: entry.path,
        added: project !== null,
        // The sidebar's name for the project.
        linkTarget: isLink ? {
          label: formatProjectLabel(project.label?.trim() || formatDirectoryName(project.path, explorerRootDirectory) || project.path),
          path: project.path,
        } : null,
      };
    });
  }, [addedProjectOf, browseDirectoryAbsolutePath, explorerRootDirectory, filteredEntries, realPaths]);

  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [query, rows.length]);

  const targetPath = React.useMemo(() => {
    if (!explorerRootDirectory) return '';
    return trimTrailingSeparators(displayPathToAbsolutePath(resolvedQuery, explorerRootDirectory));
  }, [explorerRootDirectory, resolvedQuery]);
  const selectionPaths = React.useMemo(
    () => selectedPaths.filter((path) => Boolean(normalizeDirectoryPath(path)) && !addedProjectOf(path)),
    [addedProjectOf, selectedPaths]
  );
  const togglePathSelection = React.useCallback((path: string) => {
    setSelectedPaths((prev) => (
      prev.includes(path) ? prev.filter((entry) => entry !== path) : [...prev, path]
    ));
  }, []);

  const exactEntry = React.useMemo(() => {
    if (!browseFilterQuery) return null;
    return filteredEntries.find((entry) => entry.name === browseFilterQuery) ?? null;
  }, [browseFilterQuery, filteredEntries]);
  // A clone never lands in a folder that exists: one the path field points at
  // is where the checkout goes, under the repository's own name, as with
  // `git clone`. A path that does not exist yet is the checkout itself.
  const cloneDestination = React.useMemo(() => {
    if (!isCloneMode || !targetPath || isLoading) return '';
    const pointsAtExistingFolder = hasTrailingPathSeparator(resolvedQuery)
      ? !isBrowseDirectoryMissing && browseErrorReason === null
      : exactEntry !== null;
    if (!pointsAtExistingFolder) return targetPath;
    const name = cloneDirectoryName(cloneRemoteUrl);
    if (!name) return '';
    return targetPath.endsWith('/') ? `${targetPath}${name}` : `${targetPath}/${name}`;
  }, [browseErrorReason, cloneRemoteUrl, exactEntry, isBrowseDirectoryMissing, isCloneMode, isLoading, resolvedQuery, targetPath]);
  const submitTarget = isCloneMode ? cloneDestination : targetPath;
  const isAlreadyAdded = addedProjectOf(submitTarget) !== null;
  const shouldCreateTarget = Boolean(
    targetPath
    && !isAlreadyAdded
    && (browseErrorReason === null || browseErrorReason === 'not-found')
    && (
      (hasTrailingPathSeparator(resolvedQuery) && isBrowseDirectoryMissing)
      || (!hasTrailingPathSeparator(resolvedQuery) && browseFilterQuery.trim().length > 0 && exactEntry === null)
    )
  );
  const canAddProject = !isConfirming
    && !isOpeningFinder
    && (isOpenCodeView || (
      browseErrorReason !== 'os-permission'
      && browseErrorReason !== 'invalid-response'
      && browseErrorReason !== 'unknown'
    ))
    && (selectionPaths.length > 0 || (!isOpenCodeView && !isAlreadyAdded && Boolean(submitTarget)));
  // Adding a directory that is already a repository: read what its own .git
  // states so the association can be offered instead of asked for. Nothing is
  // written until the project is added with the proposal still selected. A
  // closed dialog adds nothing: its path is the home, which it would read on
  // every launch.
  const existingRepository = useExistingRepositorySummary(targetPath, { sourceControl, git },
    open && view === 'folder' && !runtime.isVSCode && !isAlreadyAdded && !shouldCreateTarget && selectionPaths.length === 0);
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
    // The summary decides which transports the remote allows, and it counts
    // one only while its fetch and push endpoints agree: an identity applied
    // here writes a grant for the remote as a whole, so a key or credential
    // that reaches just the fetch endpoint does not answer for it. The address
    // itself — its host and SSH port — is the fetch endpoint's own.
    const fetchTraits = remoteTraits(existingPrimaryRemote.fetch.displayUrl);
    return { ...fetchTraits, https: existingPrimaryRemote.https, ssh: existingPrimaryRemote.ssh };
  }, [isCloneMode, cloneRemoteUrl, existingPrimaryRemote]);
  const identityHost = identityRemote?.host ?? null;
  const identityChoiceKey = `${isCloneMode ? 'clone' : 'add'}:${identityHost ?? ''}`;
  // An identity is specific to an instance and to a way of reaching it; one
  // that cannot serve this remote is shown with the reason, never proposed.
  const identityApplicabilityOf = React.useCallback((identity: GitIdentityProfile): IdentityApplicability =>
    identityRemote ? identityApplicability(identity, identityRemote, instanceSshHosts) : { applicable: true },
  [identityRemote, instanceSshHosts]);
  const existingAuthor = existingRepository?.author ?? null;
  // What the repository is signed as today, shown as it is: one of the stored
  // identities when the author matches one, the machine's own author, or the
  // repository's own author when it matches neither. A clone has no author
  // yet, so it is proposed an identity that can reach the address.
  const proposedIdentity = React.useMemo(() => {
    const applicable = availableGitIdentities.filter((identity) => identityApplicabilityOf(identity).applicable);
    if (!isCloneMode) {
      return activeIdentityFor(applicable, globalGitIdentity, existingAuthor, (author) => ({
        id: 'local-config', name: author.userName, ...author, color: 'info', icon: 'user',
      }));
    }
    return proposeIdentityForHost(applicable, identityHost, defaultGitIdentityId, instanceSshHosts);
  }, [availableGitIdentities, defaultGitIdentityId, existingAuthor, globalGitIdentity, identityApplicabilityOf, identityHost, instanceSshHosts, isCloneMode]);
  const identityChosen = identityChoice?.key === identityChoiceKey;
  const selectedGitIdentity = React.useMemo(() => {
    const chosen = identityChosen
      ? availableGitIdentities.find((identity) => identity.id === identityChoice?.id)
      : null;
    return chosen ?? proposedIdentity;
  }, [availableGitIdentities, identityChoice, identityChosen, proposedIdentity]);
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
    // System Git, and an identity from an earlier release that names no
    // credentials of its own, clone with whatever the machine holds.
    if (transport === 'system') return { transportMode: 'system', unverifiedConfirmed: true };
    return null;
  }, [cloneRemoteUrl, selectedGitIdentity]);

  const canSubmitClone = canAddProject && !cloneRecovery.blocked && cloneRemoteUrl.trim().length > 0
    && Boolean(cloneSelection);
  const highlightedRow = rows[highlightedIndex] ?? null;
  const submitModifierLabel = formatShortcutForDisplay('mod');
  const submitTargetName = lastPathSegment(targetPath);
  const submitActionLabel = selectionPaths.length > 0
    ? t('directoryExplorerDialog.actions.addSelected', { count: selectionPaths.length })
    : isCloneMode
      ? isConfirming
        ? t('directoryExplorerDialog.actions.cloning')
        : isAlreadyAdded
          ? t('directoryExplorerDialog.actions.alreadyAdded')
          : t('directoryExplorerDialog.actions.cloneAndAdd')
      : isOpenCodeView
        ? t('directoryExplorerDialog.actions.addProject')
        : isAlreadyAdded
          ? t('directoryExplorerDialog.actions.alreadyAdded')
          : isConfirming
            ? t('directoryExplorerDialog.actions.adding')
            : shouldCreateTarget
              ? t('directoryExplorerDialog.actions.createNamed', { name: submitTargetName })
              : t('directoryExplorerDialog.actions.addNamed', { name: submitTargetName });

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (input) input.scrollLeft = input.scrollWidth;
  }, [query]);

  // Again once the home resolves, which moves the path. A phone would raise its
  // keyboard over the list the moment the sheet opens.
  React.useLayoutEffect(() => {
    if (!open || isMobile) return;
    const frame = requestAnimationFrame(() => focusPathInput(inputRef.current));
    return () => cancelAnimationFrame(frame);
  }, [dialogHomeDirectory, isMobile, open]);

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
    if (onProjectAdded) {
      onProjectAdded({ id: projectId, path: projectPath });
      return;
    }
    if (isMobile) setSessionSwitcherOpen(false);
    openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: projectPath });
    handleClose();
  }, [handleClose, isMobile, onProjectAdded, openNewSessionDraft, setSessionSwitcherOpen]);

  const handleQuickAdd = React.useCallback(async (event: React.MouseEvent, path: string) => {
    event.stopPropagation();
    if (isConfirming) return;
    if (addedProjectOf(path)) return;
    const project = await addProject(path);
    if (!project) {
      toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
        description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
      });
      return;
    }
    openProjectDraft(project.id, project.path);
  }, [addProject, addedProjectOf, isConfirming, openProjectDraft, t]);

  const finalizeSelection = React.useCallback(async (target: string) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (isConfirming) return;
    if (isCloneMode && (!canSubmitClone || cloneController.current)) return;
    const capturedRuntime = runtimeKey;
    // Batch selections supersede the single-target flow. Only the single-target
    // flow is blocked by an already-added (or missing) directory.
    const selectionToAdd = isCloneMode
      ? []
      : selectedPaths.filter((path) => Boolean(normalizeDirectoryPath(path)) && !addedProjectOf(path));
    if (selectionToAdd.length === 0 && (!target || addedProjectOf(target))) return;
    let selectedTarget = target;
    let setupRequired = false;

    setIsAddingProject(true);
    try {
      // A folder picked outside the list (the system picker) has not been
      // resolved yet; a link to an added project is that project.
      const normalized = normalizeDirectoryPath(target);
      if (selectionToAdd.length === 0 && !isCloneMode && normalized && !realPaths.has(normalized)) {
        const realPath = normalizeDirectoryPath((await opencodeClient.getDirectoryRealPaths([target])).get(target));
        if (realPath && addedProjectsByPath.has(realPath)) return;
      }
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
      // The proposal describes the repository as it is. Nothing is written
      // unless the person picked an identity themselves: adding a directory
      // never rewrites its author or binds an account on its own.
      if (!isCloneMode && identityChosen && selectedGitIdentity && existingRepository
        && existingRepository.directory === selectedTarget) {
        const outcome = await applyIdentityToRepository({
          directory: project.path,
          // A repository with no remote binds nothing; the identity is still
          // written, because it also says who commits there.
          remoteName: existingRepository.primaryRemote?.name ?? null,
          identity: selectedGitIdentity,
        }, { git, sourceControl });
        // The project is added either way; what could not be written is said
        // here rather than swallowed, and the Git panel can finish it.
        if (outcome.status === 'failed' && outcome.reason !== 'runtime') toast.warning(t('directoryExplorerDialog.existing.bindFailed'));
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
      setIsAddingProject(false);
    }
  }, [addProject, addProjects, addedProjectOf, addedProjectsByPath, canSubmitClone, cloneRecovery, cloneSelection, identityChosen, cloneRemoteUrl, existingRepository, git, handleClose, isCloneMode, isConfirming, mobileActions, openContextSurface, openProjectDraft, realPaths, runtimeKey, selectedGitIdentity, selectedPaths, shouldCreateTarget, sourceControl, targetPath, t]);

  const browseToDisplayPath = React.useCallback((displayPath: string) => {
    setQuery(ensureBrowseDirectoryPath(displayPath));
  }, []);

  const browseToEntry = React.useCallback((entry: BrowseEntry) => {
    setQuery(appendBrowsePathSegment(resolvedQuery, entry.name));
  }, [resolvedQuery]);

  const parentDisplayPath = getBrowseParentPath(browseDirectoryDisplayPath);
  const browseUp = React.useCallback(() => {
    if (parentDisplayPath) browseToDisplayPath(parentDisplayPath);
  }, [browseToDisplayPath, parentDisplayPath]);

  const selectView = React.useCallback((next: ExplorerView, displayPath?: string) => {
    setRequestedView(next);
    // A selection survives moving between folders, so one batch can gather
    // projects from anywhere. A clone adds one repository, so it has no batch.
    if (next === 'clone') setSelectedPaths([]);
    setHighlightedIndex(0);
    if (displayPath) browseToDisplayPath(displayPath);
    if (next !== 'opencode' && !isMobile) requestAnimationFrame(() => focusPathInput(inputRef.current));
  }, [browseToDisplayPath, isMobile]);

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
    const moveHighlight = (key: 'ArrowDown' | 'ArrowUp') => {
      setHighlightedIndex((index) => key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1));
    };
    if (handleDropdownNavigationKey(event, moveHighlight)) return;
    if (event.key === 'ArrowUp' && isPrimaryModifierPressed(event)) {
      event.preventDefault();
      browseUp();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(event.key);
      return;
    }
    if (event.key === ' ') {
      // Only treat Space as a selection toggle when the user is actively
      // browsing a directory (trailing slash or no filter typing). When
      // the input is in path-entry mode, Space is a literal character
      // and must reach the input value.
      if (hasTrailingPathSeparator(resolvedQuery) && !isCloneMode) {
        event.preventDefault();
        if (canSelect && highlightedRow && !highlightedRow.added) togglePathSelection(highlightedRow.path);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isPrimaryModifierPressed(event)) {
        void finalizeSelection(submitTarget);
        return;
      }
      if (highlightedRow && !isLoading) browseToEntry(highlightedRow);
    }
  }, [browseToEntry, browseUp, canSelect, finalizeSelection, highlightedRow, isCloneMode, isLoading, resolvedQuery, rows.length, submitTarget, togglePathSelection]);

  const showHiddenToggle = (
    <Button
      variant="ghost"
      size="sm"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setShowHidden((value) => !value)}
      aria-pressed={showHidden}
      aria-label={t('directoryExplorerDialog.toggle.showHidden')}
      title={t('directoryExplorerDialog.toggle.showHidden')}
      className={cn('size-7 shrink-0 has-[>svg]:px-0', !showHidden && 'text-muted-foreground')}
    >
      <Icon name={showHidden ? 'eye' : 'eye-off'} className="size-4" />
    </Button>
  );

  /**
   * One control for the three answers a repository needs.
   *
   * The identity says whose account it is, how transfers authenticate and who
   * commits, so the screen names the configuration rather than asking for its
   * parts.
   */
  const renderIdentityPicker = (triggerClassName: string, iconOnly = false) => availableGitIdentities.length ? (
    <IdentityDropdown
      activeProfile={selectedGitIdentity ?? null}
      identities={availableGitIdentities}
      onSelect={(identity) => setIdentityChoice({ key: identityChoiceKey, id: identity.id })}
      isApplying={isConfirming}
      applicability={identityApplicabilityOf}
      triggerClassName={triggerClassName}
      iconOnly={iconOnly}
      menuAlign={iconOnly ? 'end' : 'start'}
    />
  ) : null;

  // In the footer, where it takes the hints' place: a repository found while
  // browsing must not move the list under the pointer.
  const existingRepositoryIdentity = view === 'folder' && existingRepository ? renderIdentityPicker('max-w-48') : null;

  // Both fields hold their own controls, so a control never needs a row of its own.
  const fieldClassName = 'oc-raised oc-field flex h-8 items-center gap-0.5 rounded-md bg-[var(--surface-elevated)] px-0.5';
  const fieldInputClassName = 'min-w-0 flex-1 bg-transparent font-mono typography-ui-label shadow-none hover:[&:not(:focus)]:[background-image:none] dark:bg-transparent';

  const fieldsSection = isOpenCodeView ? null : (
    // The window's close button sits at the end of this row.
    <div className={cn('flex flex-col gap-1.5 pb-2', isMobile ? 'pt-0' : 'ps-3 pe-11 pt-2')}>
      {isCloneMode ? (
        <>
          <GitOperationStatus entry={cloneRecovery.entry} onRefresh={() => void cloneRecovery.refresh()} onCancel={() => void cloneRecovery.cancel()} />
          {/* The identity answers how this address is reached. A phone has no
              tooltip to name it, so there it keeps its own line. */}
          <div dir="ltr" className={fieldClassName}>
            <Input
              inputSize="compact"
              value={cloneRemoteUrl}
              disabled={isConfirming}
              onChange={(event) => setCloneRemoteUrl(event.target.value)}
              placeholder={t('directoryExplorerDialog.clone.remoteUrlPlaceholder')}
              aria-label={t('directoryExplorerDialog.clone.remoteUrlPlaceholder')}
              className={cn(fieldInputClassName, 'px-2')}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
            {isMobile ? null : renderIdentityPicker('shrink-0 gap-0.5 has-[>svg]:px-1.5', true)}
          </div>
          {isMobile ? <div>{renderIdentityPicker('max-w-full')}</div> : null}
          {cloneRemoteUrl.trim() && selectedGitIdentity && !cloneSelection ? (
            <p className="typography-micro text-muted-foreground">{t('directoryExplorerDialog.clone.identityMismatch')}</p>
          ) : null}
        </>
      ) : null}
      {/* A path field reads left to right in every language, like code. */}
      <div dir="ltr" className={fieldClassName}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!parentDisplayPath || isConfirming}
          onMouseDown={(event) => event.preventDefault()}
          onClick={browseUp}
          aria-label={t('directoryExplorerDialog.browse.parentDirectory')}
          title={t('directoryExplorerDialog.browse.parentDirectory')}
          className="size-7 shrink-0 text-muted-foreground has-[>svg]:px-0"
        >
          <Icon name="arrow-up" className="size-4" />
        </Button>
        <Input
          ref={inputRef}
          inputSize="compact"
          value={query}
          disabled={isConfirming}
          onChange={(event) => {
            const value = normalizeSeparators(event.target.value);
            // Entering a folder by name moves the browsed folder, so the field
            // takes the full path rather than resolving against itself.
            setQuery(value.includes('/') ? resolveBrowseQuery(value, browsedFolder) : value);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('directoryExplorerDialog.pathInput.placeholder')}
          className={cn(fieldInputClassName, 'px-1')}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        {showHiddenToggle}
      </div>
    </div>
  );

  const renderSelectionBox = (path: string) => {
    const selected = selectedPaths.includes(path);
    return (
      <button
        type="button"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); togglePathSelection(path); }}
        title={t('directoryExplorerDialog.browse.selectForAdd')}
        aria-label={t('directoryExplorerDialog.browse.selectForAdd')}
        aria-pressed={selected}
        className={cn('flex flex-shrink-0 text-muted-foreground transition-colors hover:text-foreground', isMobile && '-my-3 -ms-2.5 px-2.5 py-3')}
      >
        <Icon name={selected ? 'checkbox' : 'checkbox-blank'} className={cn('size-4', selected && 'text-primary')} />
      </button>
    );
  };

  const renderRow = (row: {
    key: string;
    path: string;
    index: number;
    selectable: boolean;
    onActivate: () => void;
    rowRef?: (node: HTMLDivElement | null) => void;
    children: React.ReactNode;
  }) => {
    const isActive = row.index === highlightedIndex;
    return (
      // A div, not a button: a row holds its own select and add buttons, and a
      // button cannot contain buttons.
      <div
        key={row.key}
        ref={row.rowRef}
        role="button"
        tabIndex={0}
        onMouseEnter={() => setHighlightedIndex(row.index)}
        onFocus={() => setHighlightedIndex(row.index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={row.onActivate}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            row.onActivate();
          }
        }}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-start transition-colors focus-visible:outline-none',
          isMobile ? 'min-h-11' : 'h-7.5',
          isActive && !isMobile && 'bg-interactive-selection text-interactive-selection-foreground',
        )}
      >
        {row.selectable && (isActive || isMobile || selectionPaths.length > 0)
          ? renderSelectionBox(row.path)
          : <Icon name="folder-6" className="size-4 flex-shrink-0 text-muted-foreground" />}
        {row.children}
      </div>
    );
  };

  const folderRows = (
    <div className="space-y-0.5">
      {rows.map((row, index) => renderRow({
        key: row.value,
        path: row.path,
        index,
        selectable: canSelect && !row.added,
        // These can be the previous folder's rows for a moment.
        onActivate: () => { if (!isLoading) browseToEntry(row); },
        rowRef: (node) => {
          if (node) rowRefs.current.set(row.value, node);
          else rowRefs.current.delete(row.value);
        },
        children: (
          <>
            <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label text-foreground">{row.name}</span>
            {row.linkTarget ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex min-w-0 max-w-[40%] shrink items-center gap-1 typography-meta text-muted-foreground">
                    <Icon name="arrow-right" className="size-3.5 flex-shrink-0" />
                    <span dir="auto" className="truncate">{row.linkTarget.label}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('directoryExplorerDialog.browse.linkTarget', { path: formatPathForDisplay(row.linkTarget.path, explorerRootDirectory) })}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {row.added ? (
              <span className="typography-meta text-muted-foreground">{t('directoryExplorerDialog.browse.addedBadge')}</span>
            ) : view === 'folder' && (!isMobile || onProjectAdded) ? (
              <Button
                variant="ghost"
                size="xs"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => handleQuickAdd(event, row.path)}
                disabled={isConfirming}
                className={cn('text-muted-foreground hover:text-foreground', index !== highlightedIndex && !isMobile && 'opacity-0 focus-visible:opacity-100')}
              >
                {t('directoryExplorerDialog.browse.quickAdd')}
              </Button>
            ) : null}
            <Icon name="arrow-right-s" className="size-3.5 flex-shrink-0 text-muted-foreground" />
          </>
        ),
      }))}
    </div>
  );

  const openCodeRows = (
    <div className="space-y-0.5">
      {openCodeProjects.map((project, index) => renderRow({
        key: project.path,
        path: project.path,
        index,
        selectable: true,
        onActivate: () => togglePathSelection(project.path),
        children: (
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span dir="auto" className="min-w-0 truncate typography-ui-label text-foreground">{project.name}</span>
            <span dir="ltr" title={project.path} className="min-w-0 truncate typography-meta text-muted-foreground">
              {formatPathForDisplay(project.parent, explorerRootDirectory)}
            </span>
          </span>
        ),
      }))}
    </div>
  );

  const emptyMessage = (text: string) => (
    <div className="px-4 py-10 text-center typography-ui-label text-muted-foreground">{text}</div>
  );

  const browseBody = isLoadingSlowly ? emptyMessage(t('directoryExplorerDialog.browse.loading'))
    : browseErrorReason && browseErrorReason !== 'not-found' ? (
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
    )
    : rows.length > 0 ? folderRows
    : isLoading ? null
    : emptyMessage(shouldCreateTarget && view === 'folder'
      ? t('directoryExplorerDialog.browse.willCreate', { name: formatPathForDisplay(targetPath, explorerRootDirectory) })
      : t('directoryExplorerDialog.browse.empty'));

  const listCaption = isOpenCodeView
    ? t('directoryExplorerDialog.opencode.caption')
    : isCloneMode ? t('directoryExplorerDialog.clone.into') : null;

  const resultsSection = (
    <>
      {listCaption ? (
        <div className={cn('px-2.5 pb-1 typography-meta text-muted-foreground', !isMobile && 'ms-2', isOpenCodeView && !isMobile && 'pt-3 pe-9')}>{listCaption}</div>
      ) : null}
      <ScrollableOverlay outerClassName="min-h-0 flex-1" className={cn('pb-1', !isMobile && 'px-2')}>
        {isOpenCodeView ? openCodeRows : browseBody}
      </ScrollableOverlay>
    </>
  );

  const footerHints = (
    // One line tall: a hint a long button leaves no room for wraps out of sight whole.
    <div className="flex h-5 min-w-0 flex-wrap items-center gap-x-3 overflow-hidden whitespace-nowrap typography-micro text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
        <Icon name="arrow-down-s" className="-ms-1 h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.navigate')}
      </span>
      <span className="inline-flex items-center gap-1">
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.open')}
      </span>
      {canSelect ? (
        <span className="inline-flex items-center gap-1">
          <span>{t('directoryExplorerDialog.shortcut.space')}</span>
          {t('directoryExplorerDialog.footer.select')}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1">
        <span>{submitModifierLabel}</span>
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.add')}
      </span>
    </div>
  );

  const submitButton = (
    <Button
      size="sm"
      disabled={isCloneMode ? !canSubmitClone : !canAddProject}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void finalizeSelection(submitTarget)}
      // The batch can hold folders that are not on screen.
      title={selectionPaths.length > 0
        ? selectionPaths.map((path) => formatPathForDisplay(path, explorerRootDirectory)).join('\n')
        : submitActionLabel}
      className={isMobile ? 'min-w-0 flex-1' : 'min-w-0 max-w-72'}
    >
      <span className="truncate">{submitActionLabel}</span>
    </Button>
  );

  const finderButton = canRequestAccess && view === 'folder' ? (
    <Button variant="ghost" size="sm" onClick={handleOpenInFinder} disabled={isConfirming || isOpeningFinder} className="shrink-0">
      {isOpeningFinder ? t('directoryExplorerDialog.actions.openingFinder') : t(getDirectoryPickerLabelKey())}
    </Button>
  ) : null;

  const places: Array<{ key: string; label: string; icon: IconName; pressed: boolean; onSelect: () => void; startsGroup?: boolean }> = [
    ...['~/', ...projectBrowsePlaces(projects, explorerRootDirectory)].map((place) => ({
      key: place,
      label: place === '~/' ? t('directoryExplorerDialog.browse.home') : lastPathSegment(place),
      icon: place === '~/' ? 'home' as const : 'folder-6' as const,
      pressed: view === 'folder' && trimTrailingSeparators(browseDirectoryAbsolutePath) === trimTrailingSeparators(displayPathToAbsolutePath(place, explorerRootDirectory)),
      onSelect: () => selectView('folder', place),
    })),
  ];
  // VS Code clones nothing, and its projects are the workspace folders. Clone
  // comes before the OpenCode entry, which arrives late: it moves nothing.
  if (!runtime.isVSCode) {
    places.push({ key: 'clone', label: t('directoryExplorerDialog.actions.cloneRepository'), icon: 'git-branch', pressed: isCloneMode, onSelect: () => selectView('clone'), startsGroup: true });
  }
  if (openCodeProjects.length > 0) {
    places.push({ key: 'opencode', label: t('directoryExplorerDialog.opencode.title'), icon: 'history', pressed: isOpenCodeView, onSelect: () => selectView('opencode') });
  }

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={handleClose}
        title={t('directoryExplorerDialog.actions.addProject')}
        // Height only — the width stays on MobileOverlayPanel's shared max-w-lg
        // so this sheet matches every other mobile overlay on wide screens.
        className="h-[88dvh] max-h-[720px]"
        contentMaxHeightClassName="flex-1"
        footer={(
          <div className="flex flex-col gap-2">
            {existingRepositoryIdentity}
            <div className="flex gap-2">{finderButton}{submitButton}</div>
          </div>
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          {/* The desktop column, as one line a thumb can swipe. */}
          <div className="-mx-1 flex shrink-0 gap-1.5 overflow-x-auto px-1 pb-2">
            {places.map((place) => (
              <Button key={place.key} variant="chip" size="lg" aria-pressed={place.pressed} onClick={place.onSelect} className="shrink-0">
                {place.label}
              </Button>
            ))}
          </div>
          {fieldsSection}
          {resultsSection}
        </div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(value) => value ? onOpenChange(true) : handleClose()}>
      <DialogContent
        className="h-[min(36rem,80vh)] max-w-[45rem] flex-row gap-0 overflow-hidden p-0"
        initialFocus={false}
      >
        <aside className="oc-tile flex w-44 shrink-0 flex-col max-sm:w-32 gap-0.5 overflow-y-auto p-2">
          <DialogTitle className="px-2 pb-2.5 pt-1.5">{t('directoryExplorerDialog.actions.addProject')}</DialogTitle>
          <DialogDescription className="sr-only">{t('directoryExplorerDialog.description')}</DialogDescription>
          {places.map((place) => (
            <button
              key={place.key}
              type="button"
              aria-pressed={place.pressed}
              onClick={place.onSelect}
              className={cn(
                'flex h-7.5 shrink-0 items-center gap-2 rounded-lg px-2 text-start typography-ui-label transition-colors',
                place.startsGroup && 'mt-3',
                place.pressed ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon name={place.icon} className="size-4 shrink-0" />
              <span className="min-w-0 truncate" dir="auto">{place.label}</span>
            </button>
          ))}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {fieldsSection}
          {resultsSection}
          <div className="flex shrink-0 items-center gap-2 py-2.5 pe-3 ps-4">
            <div className="min-w-0 flex-1">
              {existingRepositoryIdentity ?? (isOpenCodeView ? null : footerHints)}
            </div>
            {finderButton}
            {submitButton}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
