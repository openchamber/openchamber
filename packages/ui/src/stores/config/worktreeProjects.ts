import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { normalizeConfigPath } from './directories';

const WORKTREE_PROJECT_MAP_KEY = 'oc.worktreeProjectMap.v2';
const LEGACY_WORKTREE_PROJECT_MAP_KEY = 'oc.worktreeProjectMap';
const MAX_WORKTREE_PROJECT_RUNTIME_MAPS = 8;
type WorktreeProjectMapEnvelope = {
    version: 2;
    legacyClaimed: boolean;
    runtimes: Record<string, { updatedAt: number; entries: Record<string, string> }>;
};
const _worktreeProjectMaps = new Map<string, Record<string, string>>();
const readWorktreeProjectEnvelope = (): WorktreeProjectMapEnvelope => {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WORKTREE_PROJECT_MAP_KEY) : null;
        if (!raw) return { version: 2, legacyClaimed: false, runtimes: {} };
        const parsed = JSON.parse(raw) as Partial<WorktreeProjectMapEnvelope>;
        if (parsed.version !== 2 || !parsed.runtimes || typeof parsed.runtimes !== 'object') {
            return { version: 2, legacyClaimed: false, runtimes: {} };
        }
        return { version: 2, legacyClaimed: parsed.legacyClaimed === true, runtimes: parsed.runtimes };
    } catch {
        return { version: 2, legacyClaimed: false, runtimes: {} };
    }
};
const writeWorktreeProjectEnvelope = (envelope: WorktreeProjectMapEnvelope): void => {
    const runtimes = Object.fromEntries(
        Object.entries(envelope.runtimes)
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_WORKTREE_PROJECT_RUNTIME_MAPS),
    );
    localStorage.setItem(WORKTREE_PROJECT_MAP_KEY, JSON.stringify({ ...envelope, runtimes }));
};
const getWorktreeProjectMap = (): Record<string, string> => {
    const runtimeKey = getRuntimeKey() || 'default';
    const existing = _worktreeProjectMaps.get(runtimeKey);
    if (existing) return existing;
    const envelope = readWorktreeProjectEnvelope();
    let map = envelope.runtimes[runtimeKey]?.entries ?? null;
    if (!map && !envelope.legacyClaimed) {
        try {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_WORKTREE_PROJECT_MAP_KEY) : null;
            map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
            envelope.legacyClaimed = true;
            envelope.runtimes[runtimeKey] = { updatedAt: Date.now(), entries: map };
            writeWorktreeProjectEnvelope(envelope);
            localStorage.removeItem(LEGACY_WORKTREE_PROJECT_MAP_KEY);
        } catch {
            map = {};
        }
    }
    const result = map ?? {};
    _worktreeProjectMaps.set(runtimeKey, result);
    return result;
};
const rememberWorktreeProject = (worktree: string, project: string): void => {
    if (!worktree || !project || worktree === project) return;
    const map = getWorktreeProjectMap();
    if (map[worktree] === project) return;
    map[worktree] = project;
    try {
        const runtimeKey = getRuntimeKey() || 'default';
        const envelope = readWorktreeProjectEnvelope();
        envelope.legacyClaimed = true;
        envelope.runtimes[runtimeKey] = { updatedAt: Date.now(), entries: map };
        writeWorktreeProjectEnvelope(envelope);
        localStorage.removeItem(LEGACY_WORKTREE_PROJECT_MAP_KEY);
    } catch {
        // localStorage quota exceeded — ignore; live resolution still works.
    }
};

const getKnownProjectDirectories = (): string[] => {
    try {
        return useProjectsStore.getState().projects
            .map((project) => normalizeConfigPath(project.path))
            .filter((path): path is string => Boolean(path));
    } catch {
        return [];
    }
};

export const resolveProjectDirectory = (directory: string | null | undefined): string | null => {
    const dir = normalizeConfigPath(directory);
    const projects = getKnownProjectDirectories();
    if (!dir) return null;
    if (projects.includes(dir)) return dir;
    if (isSpaceDirectory(dir)) return null;

    const cached = normalizeConfigPath(getWorktreeProjectMap()[dir]);
    if (cached) return cached;
    try {
        const project = resolveProjectForSessionDirectory(
            useProjectsStore.getState().projects,
            useSessionUIStore.getState().availableWorktreesByProject,
            dir,
        );
        const projectPath = normalizeConfigPath(project?.path ?? null);
        if (projectPath && projectPath !== dir) {
            rememberWorktreeProject(dir, projectPath);
            return projectPath;
        }
    } catch { /* The cached mapping, if any, was checked above. */ }
    return null;
};
