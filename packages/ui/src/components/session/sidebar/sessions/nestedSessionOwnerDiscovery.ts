import { runBackgroundNetworkTask } from '@/lib/background-network';
import { git } from '@/lib/gitApi';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { isOpenCodeTrustPaused, subscribeOpenCodeTrust } from '@/lib/opencodeTrust';
import { normalizePath } from '@/lib/pathNormalization';
import { captureRuntimeInstance, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import {
  findNestedSessionCandidates,
  NestedSessionOwnerDiscovery,
  readNestedWorktreePaths,
  type ReadOnlySessionAssociation,
} from '@/lib/worktrees/readOnlySessionAssociation';
import { buildKnownSessionDirectories } from '../list/sessionListDirectories';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

const EMPTY: ReadonlyMap<string, ReadOnlySessionAssociation> = new Map();

export function startNestedSessionOwnerDiscovery() {
  let active = true;
  let isCurrent = captureRuntimeInstance();
  let discovery: NestedSessionOwnerDiscovery;

  const candidates = () => {
    const projects = useProjectsStore.getState().projects;
    const { availableWorktreesByProject } = useSessionUIStore.getState();
    const knownDirectories = buildKnownSessionDirectories(projects, availableWorktreesByProject);
    const sessions = useGlobalSessionsStore.getState();
    return findNestedSessionCandidates(
      sessions.structure.activeRootIds.flatMap((id) => sessions.entityById.get(id) ?? []),
      projects,
      useGlobalSyncStore.getState().projects,
      knownDirectories,
    );
  };

  const publish = () => {
    if (!active || !isCurrent()) return;
    const owners = new Map([...discovery.owners(candidates())].filter(([, owner]) => !isOpenCodeTrustPaused(owner.directory)));
    const current = useSessionUIStore.getState().nestedSessionOwners;
    if (current.size === owners.size && [...owners].every(([id, owner]) => (
      current.get(id)?.directory === owner.directory
      && current.get(id)?.projectId === owner.projectId
      && current.get(id)?.projectRoot === owner.projectRoot
    ))) return;
    useSessionUIStore.setState({ nestedSessionOwners: owners });
  };

  const createDiscovery = () => new NestedSessionOwnerDiscovery(
    async (repository) => {
      const requestIsCurrent = captureRuntimeInstance();
      return (await runBackgroundNetworkTask(() => active && isCurrent() && requestIsCurrent()
        ? readNestedWorktreePaths(repository, git.worktree.list)
        : Promise.resolve(null))) ?? null;
    },
    publish,
  );

  const reconcile = () => discovery.reconcile(candidates());
  discovery = createDiscovery();

  const stopProjects = useProjectsStore.subscribe((state, previous) => {
    if (state.projects !== previous.projects) reconcile();
  });
  const stopCanonicalProjects = useGlobalSyncStore.subscribe((state, previous) => {
    if (state.projects !== previous.projects) reconcile();
  });
  const stopSessions = useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.structure !== previous.structure || state.authoritativeSessions !== previous.authoritativeSessions) reconcile();
  });
  const stopTopology = useSessionUIStore.subscribe((state, previous) => {
    if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) reconcile();
  });
  const stopEvents = subscribeOpenchamberEvents((event) => {
    if (event.type === 'event-stream-ready') {
      const current = candidates();
      discovery.invalidate(new Set(current.map((candidate) => candidate.repository)), current);
      return;
    }
    if (event.type !== 'worktree-changed') return;
    const current = candidates();
    const changed = new Set(event.directories.map(normalizePath));
    const affected = new Set(current.filter((candidate) => !changed.size
      || changed.has(candidate.repository) || changed.has(candidate.directory) || changed.has(candidate.projectRoot))
      .map((candidate) => candidate.repository));
    if (affected.size) discovery.invalidate(affected, current);
  });
  const stopTrust = subscribeOpenCodeTrust(publish);
  const stopRuntimeWillChange = subscribeRuntimeEndpointWillChange(({ previousRuntimeKey, runtimeKey }) => {
    if (previousRuntimeKey === runtimeKey) return;
    isCurrent = () => false;
    discovery.dispose();
    useSessionUIStore.setState({ nestedSessionOwners: EMPTY });
  });
  const stopRuntimeChanged = subscribeRuntimeEndpointChanged(({ previousRuntimeKey, runtimeKey }) => {
    if (previousRuntimeKey === runtimeKey) { reconcile(); return; }
    isCurrent = captureRuntimeInstance();
    discovery = createDiscovery();
    reconcile();
  });

  reconcile();
  return {
    dispose() {
      active = false;
      discovery.dispose();
      stopProjects();
      stopCanonicalProjects();
      stopSessions();
      stopTopology();
      stopEvents();
      stopTrust();
      stopRuntimeWillChange();
      stopRuntimeChanged();
      useSessionUIStore.setState({ nestedSessionOwners: EMPTY });
    },
  };
}
