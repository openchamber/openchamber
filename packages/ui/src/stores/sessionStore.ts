import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import { getSafeStorage } from "./utils/safeStorage";
import type { WorktreeMetadata } from "@/types/worktree";
import { getWorktreeStatus } from "@/lib/worktrees/worktreeStatus";
import { listProjectWorktrees, removeProjectWorktree } from "@/lib/worktrees/worktreeManager";
import { useDirectoryStore } from "./useDirectoryStore";
import { useProjectsStore } from "./useProjectsStore";
import { triggerSessionStatusPoll } from "@/hooks/useServerSessionStatus";
import type { ProjectEntry } from "@/lib/api/types";
import { checkIsGitRepository } from "@/lib/gitApi";
import { streamDebugEnabled } from "@/stores/utils/streamDebug";
import { isMissingGlobalSessionsEndpointError, readNextCursor, type GlobalSessionRecord } from "./globalSessions";

interface SessionState {
    sessions: Session[];
    archivedSessions: Session[];
    sessionsByDirectory: Map<string, Session[]>;
    currentSessionId: string | null;
    lastLoadedDirectory: string | null;
    isLoading: boolean;
    error: string | null;
    webUICreatedSessions: Set<string>;
    worktreeMetadata: Map<string, WorktreeMetadata>;
    availableWorktrees: WorktreeMetadata[];
    availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
}

interface SessionActions {
    loadSessions: () => Promise<void>;
    createSession: (title?: string, directoryOverride?: string | null, parentID?: string | null) => Promise<Session | null>;
    deleteSession: (id: string, options?: { archiveWorktree?: boolean; deleteRemoteBranch?: boolean; deleteLocalBranch?: boolean; remoteName?: string }) => Promise<boolean>;
    deleteSessions: (ids: string[], options?: { archiveWorktree?: boolean; deleteRemoteBranch?: boolean; deleteLocalBranch?: boolean; remoteName?: string; silent?: boolean }) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
    archiveSession: (id: string) => Promise<boolean>;
    archiveSessions: (ids: string[], options?: { silent?: boolean }) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
    updateSessionTitle: (id: string, title: string) => Promise<void>;
    shareSession: (id: string) => Promise<Session | null>;
    unshareSession: (id: string) => Promise<Session | null>;
    setCurrentSession: (id: string | null) => void;
    clearError: () => void;
    getSessionsByDirectory: (directory: string) => Session[];
    getDirectoryForSession: (sessionId: string) => string | null;
    applySessionMetadata: (sessionId: string, metadata: Partial<Session>) => void;
    isOpenChamberCreatedSession: (sessionId: string) => boolean;
    markSessionAsOpenChamberCreated: (sessionId: string) => void;
    initializeNewOpenChamberSession: (sessionId: string, agents: Record<string, unknown>[]) => void;
    setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null) => void;
    getWorktreeMetadata: (sessionId: string) => WorktreeMetadata | undefined;
    setSessionDirectory: (sessionId: string, directory: string | null) => void;
    updateSession: (session: Session) => void;
    removeSessionFromStore: (sessionId: string) => void;
}

type SessionStore = SessionState & SessionActions;

const safeStorage = getSafeStorage();
const SESSION_SELECTION_STORAGE_KEY = "oc.sessionSelectionByDirectory";
type SessionSelectionMap = Record<string, string>;

const readSessionSelectionMap = (): SessionSelectionMap => {
    try {
        const raw = safeStorage.getItem(SESSION_SELECTION_STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
            return {};
        }
        return Object.entries(parsed as Record<string, unknown>).reduce<SessionSelectionMap>((acc, [directory, sessionId]) => {
            if (typeof directory === "string" && typeof sessionId === "string" && directory.length > 0 && sessionId.length > 0) {
                acc[directory] = sessionId;
            }
            return acc;
        }, {});
    } catch {
        return {};
    }
};

let sessionSelectionCache: SessionSelectionMap | null = null;
let loadSessionsRequestSeq = 0;

type ProjectSessionResult = {
    projectId: string;
    projectPath: string | null;
    sessions: Session[];
    discoveredWorktrees: WorktreeMetadata[];
    validPaths: Set<string>;
};

type ProjectSessionCacheEntry = {
    cachedAt: number;
    result: ProjectSessionResult;
};

type ProjectRepoCacheEntry = {
    cachedAt: number;
    isGitRepo: boolean;
};

const PROJECT_REPO_STATUS_CACHE_TTL_MS = 120_000;
const projectSessionCache = new Map<string, ProjectSessionCacheEntry>();
const projectRepoStatusCache = new Map<string, ProjectRepoCacheEntry>();

const setProjectSessionCache = (projectPath: string, result: ProjectSessionResult) => {
    const key = normalizePath(projectPath) ?? projectPath;
    projectSessionCache.set(key, { cachedAt: Date.now(), result });
};

const pruneProjectCaches = (validProjectPaths: Iterable<string>) => {
    const valid = new Set<string>();
    for (const path of validProjectPaths) {
        const normalized = normalizePath(path) ?? path;
        if (normalized) {
            valid.add(normalized);
        }
    }

    for (const key of projectSessionCache.keys()) {
        if (!valid.has(key)) {
            projectSessionCache.delete(key);
        }
    }
    for (const key of projectRepoStatusCache.keys()) {
        if (!valid.has(key)) {
            projectRepoStatusCache.delete(key);
        }
    }
};

const getProjectRepoStatus = async (projectPath: string): Promise<boolean> => {
    const key = normalizePath(projectPath) ?? projectPath;
    const cached = projectRepoStatusCache.get(key);
    if (cached && Date.now() - cached.cachedAt <= PROJECT_REPO_STATUS_CACHE_TTL_MS) {
        return cached.isGitRepo;
    }

    const isGitRepo = await checkIsGitRepository(key).catch(() => false);
    projectRepoStatusCache.set(key, { cachedAt: Date.now(), isGitRepo });
    return isGitRepo;
};

const getSessionSelectionMap = (): SessionSelectionMap => {
    if (!sessionSelectionCache) {
        sessionSelectionCache = readSessionSelectionMap();
    }
    return sessionSelectionCache;
};

const persistSessionSelectionMap = (map: SessionSelectionMap) => {
    sessionSelectionCache = map;
    try {
        safeStorage.setItem(SESSION_SELECTION_STORAGE_KEY, JSON.stringify(map));
    } catch { /* ignored */ }
};

const getStoredSessionForDirectory = (directory: string | null | undefined): string | null => {
    if (!directory) {
        return null;
    }
    const map = getSessionSelectionMap();
    const selection = map[directory];
    return typeof selection === "string" ? selection : null;
};

const storeSessionForDirectory = (directory: string | null | undefined, sessionId: string | null) => {
    if (!directory) {
        return;
    }
    const map = { ...getSessionSelectionMap() };
    if (sessionId) {
        map[directory] = sessionId;
    } else {
        delete map[directory];
    }
    persistSessionSelectionMap(map);
};

const clearInvalidSessionSelection = (directory: string | null | undefined, validIds: Iterable<string>) => {
    if (!directory) {
        return;
    }
    const storedSelection = getStoredSessionForDirectory(directory);
    if (!storedSelection) {
        return;
    }
    const validSet = new Set(validIds);
    if (!validSet.has(storedSelection)) {
        const map = { ...getSessionSelectionMap() };
        delete map[directory];
        persistSessionSelectionMap(map);
    }
};

const archiveSessionWorktree = async (
    metadata: WorktreeMetadata,
    options?: { deleteRemoteBranch?: boolean; deleteLocalBranch?: boolean; remoteName?: string }
) => {
    const status = metadata.status ?? (await getWorktreeStatus(metadata.path).catch(() => undefined));

    const projects = useProjectsStore.getState().projects;
    const normalizedProject = normalizePath(metadata.projectDirectory) ?? metadata.projectDirectory;
    const projectEntry = projects.find((project) => normalizePath(project.path) === normalizedProject);

    const projectRef = {
        id: projectEntry?.id ?? `path:${normalizedProject}`,
        path: normalizedProject,
    };

    await removeProjectWorktree(
        projectRef,
        status ? ({ ...metadata, status } as WorktreeMetadata) : metadata,
        {
            deleteRemoteBranch: options?.deleteRemoteBranch,
            deleteLocalBranch: options?.deleteLocalBranch,
            remoteName: options?.remoteName,
        }
    );
};

const deleteSessionOnServer = async (sessionId: string, directory?: string | null): Promise<boolean> => {
    const apiClient = opencodeClient.getApiClient();
    const normalizedDirectory = normalizePath(directory ?? null);
    const response = await apiClient.session.delete({
        sessionID: sessionId,
        ...(normalizedDirectory ? { directory: normalizedDirectory } : {}),
    });
    return Boolean(response.data);
};

const setSessionArchivedOnServer = async (
    sessionId: string,
    archivedAt: number,
    directory?: string | null,
): Promise<Session | null> => {
    const apiClient = opencodeClient.getApiClient();
    const normalizedDirectory = normalizePath(directory ?? null);
    const response = await apiClient.session.update({
        sessionID: sessionId,
        ...(normalizedDirectory ? { directory: normalizedDirectory } : {}),
        time: { archived: archivedAt },
    });
    return response.data ?? null;
};

const normalizePath = (value?: string | null): string | null => {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const replaced = trimmed.replace(/\\/g, "/");
    if (replaced === "/") {
        return "/";
    }
    return replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
};

const readVSCodeWorkspaceDirectory = (): string | null => {
    if (typeof window === "undefined") {
        return null;
    }
    const config = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__;
    const workspaceFolder = typeof config?.workspaceFolder === "string" ? config.workspaceFolder : null;
    return normalizePath(workspaceFolder);
};

const isVSCodeRuntime = (): boolean => {
    if (typeof window === "undefined") return false;
    const runtime = (window as unknown as { __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { isVSCode?: boolean } } })
        .__OPENCHAMBER_RUNTIME_APIS__?.runtime;
    return Boolean(runtime?.isVSCode);
};

const vscodeDebugLog = (...args: unknown[]) => {
    if (!streamDebugEnabled()) return;
    if (!isVSCodeRuntime()) return;
    console.log("[OpenChamber][VSCode][sessions]", ...args);
};

const dedupeSessionsById = (sessions: Session[]): Session[] => {
    const map = new Map<string, Session>();

    sessions.forEach((session) => {
        if (!session || typeof session.id !== "string" || session.id.length === 0) {
            return;
        }

        const existing = map.get(session.id);
        if (!existing) {
            map.set(session.id, session);
            return;
        }

        const existingUpdated = (existing as { time?: { updated?: number | null } }).time?.updated ?? 0;
        const candidateUpdated = (session as { time?: { updated?: number | null } }).time?.updated ?? 0;
        if (candidateUpdated > existingUpdated) {
            map.set(session.id, session);
        }
    });

    return Array.from(map.values());
};

const buildSessionsByDirectory = (sessions: Session[]): Map<string, Session[]> => {
    const map = new Map<string, Session[]>();

    sessions.forEach((session) => {
        const directory = normalizePath((session as { directory?: string | null }).directory ?? null);
        if (!directory) {
            return;
        }

        const existing = map.get(directory);
        if (existing) {
            existing.push(session);
        } else {
            map.set(directory, [session]);
        }
    });

    for (const [key, value] of map.entries()) {
        map.set(key, dedupeSessionsById(value));
    }

    return map;
};

const getSessionDirectory = (sessions: Session[], sessionId: string): string | null => {
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) {
        return null;
    }
    return normalizePath((target as { directory?: string | null }).directory ?? null);
};

const hydrateSessionWorktreeMetadata = async (
    sessions: Session[],
    projectDirectory: string | null,
    existingMetadata: Map<string, WorktreeMetadata>,
    preloadedWorktrees?: WorktreeMetadata[]
): Promise<Map<string, WorktreeMetadata> | null> => {
    const normalizedProject = normalizePath(projectDirectory);
    if (!normalizedProject || sessions.length === 0) {
        return null;
    }

    const sessionsWithDirectory = sessions
        .map((session) => ({ id: session.id, directory: normalizePath((session as { directory?: string }).directory) }))
        .filter((entry): entry is { id: string; directory: string } => Boolean(entry.directory));

    if (sessionsWithDirectory.length === 0) {
        return null;
    }

    let worktreeEntries: WorktreeMetadata[];
    if (Array.isArray(preloadedWorktrees)) {
        worktreeEntries = preloadedWorktrees;
    } else {
        try {
            worktreeEntries = await listProjectWorktrees({ id: `path:${normalizedProject}`, path: normalizedProject });
        } catch (error) {
            console.debug("Failed to hydrate worktree metadata from worktree list:", error);
            return null;
        }
    }

    if (!Array.isArray(worktreeEntries) || worktreeEntries.length === 0) {
        let mutated = false;
        const next = new Map(existingMetadata);
        sessionsWithDirectory.forEach(({ id }) => {
            if (next.delete(id)) {
                mutated = true;
            }
        });
        return mutated ? next : null;
    }

    const worktreeMapByPath = new Map<string, WorktreeMetadata>();
    worktreeEntries.forEach((metadata) => {
        const normalizedPath = normalizePath(metadata.path) ?? metadata.path;

        if (normalizedPath === normalizedProject) {
            return;
        }

        worktreeMapByPath.set(normalizedPath, metadata);
    });

    let mutated = false;
    const next = new Map(existingMetadata);

    const mergeHydratedMetadata = (
        hydrated: WorktreeMetadata,
        previous?: WorktreeMetadata
    ): WorktreeMetadata => {
        if (!previous) {
            return hydrated;
        }
        return {
            ...previous,
            ...hydrated,
            branch: hydrated.branch || previous.branch,
            label: hydrated.label || previous.label,
            name: hydrated.name || previous.name,
            projectDirectory: hydrated.projectDirectory || previous.projectDirectory,
            createdFromBranch: hydrated.createdFromBranch || previous.createdFromBranch,
            kind: hydrated.kind || previous.kind,
            status: hydrated.status || previous.status,
        };
    };

    sessionsWithDirectory.forEach(({ id, directory }) => {
        const metadata = worktreeMapByPath.get(directory);
        if (!metadata) {
            if (next.delete(id)) {
                mutated = true;
            }
            return;
        }

        const previous = next.get(id);
        const merged = mergeHydratedMetadata(metadata, previous);
        if (
            !previous ||
            previous.path !== merged.path ||
            previous.branch !== merged.branch ||
            previous.label !== merged.label ||
            previous.name !== merged.name ||
            previous.projectDirectory !== merged.projectDirectory ||
            previous.createdFromBranch !== merged.createdFromBranch ||
            previous.kind !== merged.kind ||
            previous.source !== merged.source
        ) {
            next.set(id, merged);
            mutated = true;
        }
    });

    return mutated ? next : null;
};

export const useSessionStore = create<SessionStore>()(
    devtools(
        persist(
            (set, get) => ({

                sessions: [],
                archivedSessions: [],
                sessionsByDirectory: new Map(),
                currentSessionId: null,
                lastLoadedDirectory: null,
                isLoading: false,
                error: null,
                webUICreatedSessions: new Set(),
                worktreeMetadata: new Map(),
                availableWorktrees: [],
                availableWorktreesByProject: new Map(),

                loadSessions: async () => {
                    const requestSeq = ++loadSessionsRequestSeq;
                    const isLatestRequest = () => requestSeq === loadSessionsRequestSeq;
                    set({ isLoading: true, error: null });
                    try {
                        const directoryStore = useDirectoryStore.getState();
                        const projectsStore = useProjectsStore.getState();
                        const apiClient = opencodeClient.getApiClient();
                        const vscodeWorkspaceDirectory = readVSCodeWorkspaceDirectory();
                        const includeDescendants = Boolean(vscodeWorkspaceDirectory);

                        vscodeDebugLog("loadSessions:start", {
                            workspace: vscodeWorkspaceDirectory,
                            currentDirectory: directoryStore.currentDirectory,
                            clientDirectory: opencodeClient.getDirectory(),
                            projectsCount: projectsStore.projects.length,
                            activeProjectId: projectsStore.activeProjectId,
                        });

                        const normalizedFallback = normalizePath(directoryStore.currentDirectory ?? opencodeClient.getDirectory() ?? null);
                        const activeProject = projectsStore.projects.find((project) => project.id === projectsStore.activeProjectId) ?? null;
                        const activeProjectRoot = normalizePath(activeProject?.path ?? null);

                        const legacyRoot = activeProjectRoot ?? normalizedFallback ?? null;

                        const projectEntries: Array<Pick<ProjectEntry, 'id' | 'path'>> = projectsStore.projects.length > 0
                            ? projectsStore.projects
                            : (legacyRoot ? [{ id: 'legacy', path: legacyRoot }] : []);

                        const resolveSessionDirectory = (session: Session): string | null => {
                            const direct = normalizePath((session as { directory?: string | null }).directory ?? null);
                            if (direct) {
                                return direct;
                            }
                            const projectWorktree = normalizePath((session as GlobalSessionRecord).project?.worktree ?? null);
                            return projectWorktree;
                        };

                        const matchesProjectDirectory = (sessionDirectory: string | null, projectDirectory: string): boolean => {
                            if (!sessionDirectory) {
                                return false;
                            }
                            if (sessionDirectory === projectDirectory) {
                                return true;
                            }
                            return includeDescendants && sessionDirectory.startsWith(`${projectDirectory}/`);
                        };

                        const applyProjectResults = async (projectResults: ProjectSessionResult[], archivedSessions: Session[]) => {
                            const sessionsByDirectory = new Map<string, Session[]>();
                            projectResults.forEach((result) => {
                                if (!result.projectPath) {
                                    return;
                                }

                                result.validPaths.forEach((directory) => {
                                    const directoryKey = normalizePath(directory) ?? directory;
                                    const directorySessions = result.sessions.filter((session) => {
                                        const dir = normalizePath((session as { directory?: string | null }).directory ?? null) ?? directoryKey;
                                        return dir === directoryKey;
                                    });
                                    sessionsByDirectory.set(directoryKey, dedupeSessionsById(directorySessions));
                                });
                            });

                            const mergedSessions: Session[] = dedupeSessionsById(Array.from(sessionsByDirectory.values()).flat());
                            const stateSnapshot = get();

                            let nextWorktreeMetadata = stateSnapshot.worktreeMetadata;
                            for (const result of projectResults) {
                                if (!result.projectPath) {
                                    continue;
                                }
                                try {
                                    const hydratedMetadata = await hydrateSessionWorktreeMetadata(
                                        result.sessions,
                                        result.projectPath,
                                        nextWorktreeMetadata,
                                        result.discoveredWorktrees
                                    );
                                    if (hydratedMetadata) {
                                        nextWorktreeMetadata = hydratedMetadata;
                                    }
                                } catch (metadataError) {
                                    console.debug("Failed to refresh worktree metadata during session load:", metadataError);
                                }
                            }

                            const worktreesByProject = new Map<string, WorktreeMetadata[]>();
                            projectResults.forEach((result) => {
                                if (result.projectPath) {
                                    worktreesByProject.set(result.projectPath, result.discoveredWorktrees);
                                }
                            });

                            const allValidPaths = new Set<string>();
                            projectResults.forEach((result) => {
                                result.validPaths.forEach((value) => {
                                    const key = normalizePath(value) ?? value;
                                    if (key) {
                                        allValidPaths.add(key);
                                    }
                                });
                            });

                            const activeDirectoryCandidate = normalizedFallback ?? activeProjectRoot ?? null;
                            const activeDirectory = activeDirectoryCandidate && allValidPaths.has(activeDirectoryCandidate)
                                ? activeDirectoryCandidate
                                : (activeProjectRoot ?? activeDirectoryCandidate);

                            const activeDirectorySessions = activeDirectory
                                ? sessionsByDirectory.get(activeDirectory) ?? []
                                : mergedSessions;

                            const validSessionIds = new Set(mergedSessions.map((session) => session.id));

                            // Keep directory-scoped stored selections tidy.
                            for (const [directoryKey, directorySessions] of sessionsByDirectory.entries()) {
                                clearInvalidSessionSelection(directoryKey, directorySessions.map((session) => session.id));
                            }

                            const directoryChanged = (activeDirectory ?? null) !== (stateSnapshot.lastLoadedDirectory ?? null);

                            let nextCurrentId = stateSnapshot.currentSessionId;
                            const currentSessionInActiveDirectory = Boolean(
                                nextCurrentId && activeDirectorySessions.some((session) => session.id === nextCurrentId)
                            );
                            if (!nextCurrentId || !validSessionIds.has(nextCurrentId) || (directoryChanged && !currentSessionInActiveDirectory)) {
                                nextCurrentId = activeDirectorySessions[0]?.id ?? mergedSessions[0]?.id ?? null;
                            }

                            if (activeDirectory) {
                                const storedSelection = getStoredSessionForDirectory(activeDirectory);
                                if (storedSelection && validSessionIds.has(storedSelection)) {
                                    nextCurrentId = storedSelection;
                                }
                            }

                            const resolvedDirectoryForCurrent = (() => {
                                if (!nextCurrentId) {
                                    return activeDirectory ?? null;
                                }
                                const metadataPath = nextWorktreeMetadata.get(nextCurrentId)?.path;
                                if (metadataPath) {
                                    return normalizePath(metadataPath) ?? metadataPath;
                                }
                                const sessionDir = getSessionDirectory(mergedSessions, nextCurrentId);
                                if (sessionDir) {
                                    return sessionDir;
                                }
                                return activeDirectory ?? null;
                            })();

                            if (!isLatestRequest()) {
                                return;
                            }

                            try {
                                opencodeClient.setDirectory(resolvedDirectoryForCurrent ?? undefined);
                            } catch (error) {
                                console.warn("Failed to sync OpenCode directory after session load:", error);
                            }

                            const activeWorktrees = activeProjectRoot
                                ? projectResults.find((result) => result.projectPath === activeProjectRoot)?.discoveredWorktrees ?? []
                                : [];

                            set({
                                sessions: mergedSessions,
                                archivedSessions,
                                sessionsByDirectory,
                                currentSessionId: nextCurrentId,
                                lastLoadedDirectory: activeDirectory ?? null,
                                isLoading: false,
                                worktreeMetadata: nextWorktreeMetadata,
                                availableWorktrees: activeWorktrees,
                                availableWorktreesByProject: worktreesByProject,
                            });

                            if (activeDirectory) {
                                storeSessionForDirectory(activeDirectory, nextCurrentId);
                            }
                            if (resolvedDirectoryForCurrent && resolvedDirectoryForCurrent !== activeDirectory) {
                                storeSessionForDirectory(resolvedDirectoryForCurrent, nextCurrentId);
                            }
                        };

                        if (projectEntries.length === 0) {
                            if (!isLatestRequest()) {
                                return;
                            }
                            set({
                                sessions: [],
                                archivedSessions: [],
                                sessionsByDirectory: new Map(),
                                currentSessionId: null,
                                lastLoadedDirectory: null,
                                isLoading: false,
                                worktreeMetadata: new Map(),
                                availableWorktrees: [],
                                availableWorktreesByProject: new Map(),
                            });
                            return;
                        }

                        pruneProjectCaches(projectEntries.map((entry) => entry.path));

                        const buildProjectResults = async (sourceSessions: Session[]): Promise<ProjectSessionResult[]> => {
                            return Promise.all(
                                projectEntries.map(async (project: Pick<ProjectEntry, 'id' | 'path'>) => {
                                    const normalizedProject = normalizePath(project.path);
                                    if (!normalizedProject) {
                                        return {
                                            projectId: project.id,
                                            projectPath: null,
                                            sessions: [],
                                            discoveredWorktrees: [],
                                            validPaths: new Set<string>(),
                                        };
                                    }

                                    const isGitRepo = await getProjectRepoStatus(normalizedProject);
                                    let discoveredWorktrees: WorktreeMetadata[] = [];
                                    const validPaths = new Set<string>([normalizedProject]);
                                    if (isGitRepo) {
                                        discoveredWorktrees = await listProjectWorktrees({
                                            id: project.id,
                                            path: normalizedProject,
                                        }).catch(() => []);
                                        discoveredWorktrees.forEach((meta) => {
                                            if (meta?.path) {
                                                validPaths.add(normalizePath(meta.path) ?? meta.path);
                                            }
                                        });
                                    }

                                    const mergedSessions = dedupeSessionsById(
                                        sourceSessions.filter((session) => {
                                            const sessionDirectory = resolveSessionDirectory(session);
                                            if (!sessionDirectory) {
                                                return false;
                                            }
                                            for (const projectPath of validPaths) {
                                                if (matchesProjectDirectory(sessionDirectory, projectPath)) {
                                                    return true;
                                                }
                                            }
                                            return false;
                                        }),
                                    );

                                    const result: ProjectSessionResult = {
                                        projectId: project.id,
                                        projectPath: normalizedProject,
                                        sessions: mergedSessions,
                                        discoveredWorktrees,
                                        validPaths,
                                    };
                                    setProjectSessionCache(normalizedProject, result);
                                    return result;
                                }),
                            );
                        };

                        try {
                            const pageSize = 500;
                            const previousArchivedSessions = dedupeSessionsById(get().archivedSessions);
                            const firstPage = await apiClient.experimental.session.list({ limit: pageSize, archived: false });
                            let liveSessions = dedupeSessionsById(Array.isArray(firstPage.data) ? firstPage.data as Session[] : []);
                            let archivedSessions: Session[] = [];
                            let hasLoadedArchivedSessions = false;

                            const apply = async () => {
                                if (!isLatestRequest()) {
                                    return;
                                }
                                const projectResults = await buildProjectResults(liveSessions);
                                const archivedForRender = hasLoadedArchivedSessions
                                    ? dedupeSessionsById(archivedSessions)
                                    : previousArchivedSessions;
                                await applyProjectResults(projectResults, archivedForRender);
                            };

                            await apply();

                            const backgroundLoad = async () => {
                                let cursor = readNextCursor(firstPage) ?? undefined;
                                while (cursor && isLatestRequest()) {
                                    const response = await apiClient.experimental.session.list({
                                        limit: pageSize,
                                        cursor,
                                        archived: false,
                                    });
                                    const page = Array.isArray(response.data) ? response.data as Session[] : [];
                                    if (page.length === 0) {
                                        break;
                                    }
                                    liveSessions = dedupeSessionsById([...liveSessions, ...page]);
                                    await apply();
                                    cursor = readNextCursor(response) ?? undefined;
                                }

                                let archivedCursor: number | undefined;
                                while (isLatestRequest()) {
                                    const response = await apiClient.experimental.session.list({
                                        limit: pageSize,
                                        archived: true,
                                        ...(archivedCursor ? { cursor: archivedCursor } : {}),
                                    });
                                    const page = Array.isArray(response.data)
                                        ? (response.data as Session[]).filter((session) => Boolean(session.time?.archived))
                                        : [];
                                    if (page.length > 0) {
                                        hasLoadedArchivedSessions = true;
                                        archivedSessions = dedupeSessionsById([...archivedSessions, ...page]);
                                        await apply();
                                    }
                                    const next = readNextCursor(response);
                                    if (!next) {
                                        break;
                                    }
                                    archivedCursor = next;
                                }

                                if (!hasLoadedArchivedSessions && isLatestRequest()) {
                                    hasLoadedArchivedSessions = true;
                                    archivedSessions = [];
                                    await apply();
                                }
                            };

                            void backgroundLoad().catch((error) => {
                                console.debug("Failed to load additional global sessions:", error);
                            });

                            return;
                        } catch (error) {
                            if (!isMissingGlobalSessionsEndpointError(error)) {
                                throw error;
                            }
                            console.debug("Global session endpoint unavailable, using legacy loader");
                        }

                        const fallbackResponse = await apiClient.session.list(undefined);
                        const fallbackSessions = dedupeSessionsById(Array.isArray(fallbackResponse.data) ? fallbackResponse.data : []);
                        const fallbackProjectResults = await buildProjectResults(fallbackSessions);
                        await applyProjectResults(fallbackProjectResults, []);
                    } catch (error) {
                        if (!isLatestRequest()) {
                            return;
                        }
                        set({
                            error: error instanceof Error ? error.message : "Failed to load sessions",
                            isLoading: false,
                        });
                    }
                },

                createSession: async (title?: string, directoryOverride?: string | null, parentID?: string | null) => {
                    set({ error: null });
                    const directoryStore = useDirectoryStore.getState();
                    const fallbackDirectory = normalizePath(directoryStore.currentDirectory);
                    const vscodeWorkspaceDirectory = readVSCodeWorkspaceDirectory();
                    const targetDirectory = vscodeWorkspaceDirectory ?? normalizePath(directoryOverride ?? opencodeClient.getDirectory() ?? fallbackDirectory);
                    vscodeDebugLog("createSession:start", { title, parentID, targetDirectory, vscodeWorkspaceDirectory });

                    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                    const previousState = get();
                    const existingIds = new Set(previousState.sessions.map((s) => s.id));
                    const optimisticSession: Session = {
                        id: tempId,
                        title: title || "New session",
                        parentID: parentID ?? undefined,
                        directory: targetDirectory ?? null,
                        projectID: (previousState.sessions[0] as { projectID?: string })?.projectID ?? "",
                        version: "0.0.0",
                        time: {
                            created: Date.now(),
                            updated: Date.now(),
                        },
                        summary: undefined,
                        share: undefined,
                    } as Session;

                    set((state) => {
                        const nextSessions = [optimisticSession, ...state.sessions];
                        const nextByDirectory = new Map(state.sessionsByDirectory);
                        if (targetDirectory) {
                            const existing = nextByDirectory.get(targetDirectory) ?? [];
                            nextByDirectory.set(targetDirectory, dedupeSessionsById([optimisticSession, ...existing]));
                        }

                        return {
                            sessions: nextSessions,
                            sessionsByDirectory: nextByDirectory,
                            currentSessionId: tempId,
                            webUICreatedSessions: new Set([...state.webUICreatedSessions, tempId]),
                            isLoading: false,
                        };
                    });

                    if (targetDirectory) {
                        try {
                            opencodeClient.setDirectory(targetDirectory);
                        } catch (error) {
                            console.warn("Failed to sync OpenCode directory after session creation:", error);
                        }
                    }

                    const replaceOptimistic = (real: Session) => {
                        const normalizedTarget = targetDirectory ?? null;
                        const normalizedReal: Session = (normalizedTarget
                            ? ({ ...real, directory: normalizedTarget } as Session)
                            : real);
                        set((state) => {
                            const updatedSessions = state.sessions.map((item) => (item.id === tempId ? normalizedReal : item));

                            const nextByDirectory = new Map(state.sessionsByDirectory);
                            if (targetDirectory) {
                                const existing = nextByDirectory.get(targetDirectory) ?? [];
                                const replaced = existing.map((item) => (item.id === tempId ? normalizedReal : item));
                                nextByDirectory.set(targetDirectory, dedupeSessionsById(replaced));
                            }

                            return {
                                sessions: updatedSessions,
                                sessionsByDirectory: buildSessionsByDirectory(updatedSessions),
                                currentSessionId: normalizedReal.id,
                                webUICreatedSessions: new Set([
                                    ...Array.from(state.webUICreatedSessions).filter((id) => id !== tempId),
                                    normalizedReal.id,
                                ]),
                            };
                        });
                        storeSessionForDirectory(targetDirectory ?? null, normalizedReal.id);
                    };

                    const pollForSession = async (): Promise<Session | null> => {
                        const apiClient = opencodeClient.getApiClient();
                        const attempts = 20;
                        for (let attempt = 0; attempt < attempts; attempt += 1) {
                            try {
                                const response = await apiClient.session.list(
                                    targetDirectory ? { directory: targetDirectory } : undefined
                                );
                                const list = Array.isArray(response.data) ? response.data : [];
                                const candidate = list.find((entry) => {
                                    if (existingIds.has(entry.id)) return false;
                                    if (title && entry.title && entry.title !== title) return false;
                                    return true;
                                });
                                if (candidate) {
                                    return candidate as Session;
                                }
                            } catch (pollError) {
                                console.debug("Session poll attempt failed:", pollError);
                            }
                            await new Promise((resolve) => setTimeout(resolve, 2000));
                        }
                        return null;
                    };

                    try {
                        const createRequest = () => opencodeClient.createSession({ title, parentID: parentID ?? undefined });
                        let session: Session | null = null;

                        try {
                            session = targetDirectory
                                ? await opencodeClient.withDirectory(targetDirectory, createRequest)
                                : await createRequest();
                        } catch (creationError) {
                            console.warn("Direct session create failed or timed out, falling back to polling:", creationError);
                        }

                        if (!session) {
                            session = await pollForSession();
                        }

                        if (session) {
                            replaceOptimistic(session);
                            return session;
                        }

                        set((state) => ({
                            sessions: state.sessions.filter((s) => s.id !== tempId),
                            currentSessionId: previousState.currentSessionId,
                            webUICreatedSessions: new Set(
                                Array.from(state.webUICreatedSessions).filter((id) => id !== tempId)
                            ),
                            isLoading: false,
                            error: "Failed to create session",
                        }));
                        return null;
                    } catch (error) {

                        set((state) => ({
                            sessions: state.sessions.filter((s) => s.id !== tempId),
                            currentSessionId: previousState.currentSessionId,
                            webUICreatedSessions: new Set(
                                Array.from(state.webUICreatedSessions).filter((id) => id !== tempId)
                            ),
                            isLoading: false,
                            error: error instanceof Error ? error.message : "Failed to create session",
                        }));
                        return null;
                    }
                },

                deleteSession: async (id: string, options) => {
                    set({ isLoading: true, error: null });
                    const metadata = get().worktreeMetadata.get(id);
                    const metadataPath = typeof metadata?.path === 'string' ? metadata.path : null;
                    const metadataProjectDirectory = typeof metadata?.projectDirectory === 'string' ? metadata.projectDirectory : null;
                    const snapshot = get();
                    const sessionDirectory = getSessionDirectory([...snapshot.sessions, ...snapshot.archivedSessions], id);
                    const requestDirectory = normalizePath(metadataProjectDirectory)
                        ?? normalizePath(sessionDirectory)
                        ?? normalizePath(opencodeClient.getDirectory() ?? null)
                        ?? null;

                    let archiveSucceeded = false;
                    try {
                        const success = await deleteSessionOnServer(id, requestDirectory);
                        if (!success) {
                            set({
                                isLoading: false,
                                error: "Failed to delete session",
                            });
                            return false;
                        }

                        if (metadata && options?.archiveWorktree) {
                            try {
                                await archiveSessionWorktree(metadata, {
                                    deleteRemoteBranch: options?.deleteRemoteBranch,
                                    deleteLocalBranch: options?.deleteLocalBranch,
                                    remoteName: options?.remoteName,
                                });
                                archiveSucceeded = true;
                            } catch (error) {
                                const message = error instanceof Error ? error.message : "Failed to delete worktree";
                                set({ error: message });
                            }
                        }

                        let nextCurrentId: string | null = null;
                        set((state) => {
                            const filteredSessions = state.sessions.filter((s) => s.id !== id);
                            const filteredArchivedSessions = state.archivedSessions.filter((s) => s.id !== id);
                            nextCurrentId = state.currentSessionId === id ? null : state.currentSessionId;
                            const nextMetadata = new Map(state.worktreeMetadata);
                            nextMetadata.delete(id);
                            const shouldRemoveWorktreeFromLists = Boolean(metadataPath && options?.archiveWorktree && archiveSucceeded);
                            const nextAvailableWorktrees = shouldRemoveWorktreeFromLists
                                ? state.availableWorktrees.filter((entry) => normalizePath(entry.path) !== normalizePath(metadataPath))
                                : state.availableWorktrees;
                            const nextAvailableWorktreesByProject = new Map(state.availableWorktreesByProject);
                            if (shouldRemoveWorktreeFromLists && metadataProjectDirectory) {
                                const projectKey = normalizePath(metadataProjectDirectory) ?? metadataProjectDirectory;
                                const projectWorktrees = nextAvailableWorktreesByProject.get(projectKey) ?? [];
                                nextAvailableWorktreesByProject.set(
                                    projectKey,
                                    projectWorktrees.filter((entry) => normalizePath(entry.path) !== normalizePath(metadataPath))
                                );
                            }
                            return {
                                sessions: filteredSessions,
                                archivedSessions: filteredArchivedSessions,
                                sessionsByDirectory: buildSessionsByDirectory(filteredSessions),
                                currentSessionId: nextCurrentId,
                                isLoading: false,
                                worktreeMetadata: nextMetadata,
                                availableWorktrees: nextAvailableWorktrees,
                                availableWorktreesByProject: nextAvailableWorktreesByProject,
                            };
                        });

                        const directoryToStore = normalizePath(sessionDirectory)
                            ?? normalizePath(opencodeClient.getDirectory() ?? null)
                            ?? null;
                        storeSessionForDirectory(directoryToStore, nextCurrentId);

                        return true;
                    } catch (error) {
                        const message = error instanceof Error ? error.message : "Failed to delete session";
                        set({
                            error: message,
                            isLoading: false,
                        });
                        return false;
                    }
                },

                deleteSessions: async (
                    ids: string[],
                    options?: { archiveWorktree?: boolean; deleteRemoteBranch?: boolean; deleteLocalBranch?: boolean; remoteName?: string; silent?: boolean }
                ) => {
                    const uniqueIds = Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
                    if (uniqueIds.length === 0) {
                        return { deletedIds: [], failedIds: [] };
                    }

                    const silent = options?.silent === true;
                    if (!silent) {
                        set({ isLoading: true, error: null });
                    }
                    const deletedIds: string[] = [];
                    const failedIds: string[] = [];
                    const worktreesToArchive = new Map<string, WorktreeMetadata>();
                    const archivedWorktreePaths = new Set<string>();

                    for (const id of uniqueIds) {
                        try {
                            const metadata = get().worktreeMetadata.get(id);
                            const sessionDirectory = getSessionDirectory([...get().sessions, ...get().archivedSessions], id);
                            const requestDirectory = normalizePath(metadata?.projectDirectory ?? null)
                                ?? normalizePath(sessionDirectory)
                                ?? normalizePath(opencodeClient.getDirectory() ?? null)
                                ?? null;

                            if (metadata && options?.archiveWorktree) {
                                const key = normalizePath(metadata.path) ?? metadata.path;
                                if (!archivedWorktreePaths.has(key)) {
                                    archivedWorktreePaths.add(key);
                                    worktreesToArchive.set(key, metadata);
                                }
                            }

                            const success = await deleteSessionOnServer(id, requestDirectory);
                            if (success) {
                                deletedIds.push(id);
                            } else {
                                failedIds.push(id);
                            }
                        } catch {
                            failedIds.push(id);
                        }
                    }

                    const archivedWorktrees: Array<{ path: string; projectDirectory: string }> = [];
                    const archiveFailures: string[] = [];

                    if (options?.archiveWorktree && worktreesToArchive.size > 0) {
                        for (const metadata of worktreesToArchive.values()) {
                            try {
                                await archiveSessionWorktree(metadata, {
                                    deleteRemoteBranch: options?.deleteRemoteBranch,
                                    deleteLocalBranch: options?.deleteLocalBranch,
                                    remoteName: options?.remoteName,
                                });
                                archivedWorktrees.push({ path: metadata.path, projectDirectory: metadata.projectDirectory });
                            } catch (error) {
                                const message = error instanceof Error ? error.message : "Failed to delete worktree";
                                archiveFailures.push(message);
                            }
                        }
                    }

                    if (archiveFailures.length > 0) {
                        set({ error: archiveFailures[0] });
                    }

                    const directoryStore = useDirectoryStore.getState();
                    archivedWorktrees.forEach(({ path, projectDirectory }) => {
                        if (directoryStore.currentDirectory === path) {
                            directoryStore.setDirectory(projectDirectory, { showOverlay: false });
                        }
                    });

                    const deletedSet = new Set(deletedIds);
                    const errorMessage = failedIds.length > 0
                        ? (failedIds.length === uniqueIds.length ? "Failed to delete sessions" : "Failed to delete some sessions")
                        : null;
                    let nextCurrentId: string | null = null;

                    set((state) => {
                        const filteredSessions = state.sessions.filter((session) => !deletedSet.has(session.id));
                        const filteredArchivedSessions = state.archivedSessions.filter((session) => !deletedSet.has(session.id));
                        if (state.currentSessionId && deletedSet.has(state.currentSessionId)) {
                            nextCurrentId = null;
                        } else {
                            nextCurrentId = state.currentSessionId;
                        }

                        const nextMetadata = new Map(state.worktreeMetadata);
                        for (const removedId of deletedSet) {
                            nextMetadata.delete(removedId);
                        }

                        const removedPaths = new Set(
                            archivedWorktrees
                                .map((entry) => normalizePath(entry.path))
                                .filter((p): p is string => Boolean(p))
                        );
                        const nextAvailableWorktrees = removedPaths.size > 0
                            ? state.availableWorktrees.filter((entry) => !removedPaths.has(normalizePath(entry.path) ?? entry.path))
                            : state.availableWorktrees;

                        const nextAvailableWorktreesByProject = new Map(state.availableWorktreesByProject);
                        if (archivedWorktrees.length > 0) {
                            const removedPathsByProject = archivedWorktrees.reduce<Map<string, Set<string>>>((accumulator, entry) => {
                                const projectKey = normalizePath(entry.projectDirectory) ?? entry.projectDirectory;
                                const pathKey = normalizePath(entry.path) ?? entry.path;
                                if (!accumulator.has(projectKey)) {
                                    accumulator.set(projectKey, new Set());
                                }
                                accumulator.get(projectKey)?.add(pathKey);
                                return accumulator;
                            }, new Map());

                            removedPathsByProject.forEach((paths, projectKey) => {
                                const projectWorktrees = nextAvailableWorktreesByProject.get(projectKey) ?? [];
                                const filtered = projectWorktrees.filter(
                                    (entry) => !paths.has(normalizePath(entry.path) ?? entry.path)
                                );
                                nextAvailableWorktreesByProject.set(projectKey, filtered);
                            });
                        }

                        return {
                            sessions: filteredSessions,
                            archivedSessions: filteredArchivedSessions,
                            sessionsByDirectory: buildSessionsByDirectory(filteredSessions),
                            currentSessionId: nextCurrentId,
                            ...(silent ? {} : { isLoading: false, error: errorMessage }),
                            worktreeMetadata: nextMetadata,
                            availableWorktrees: nextAvailableWorktrees,
                            availableWorktreesByProject: nextAvailableWorktreesByProject,
                        };
                    });

                    const directory = opencodeClient.getDirectory() ?? null;
                    storeSessionForDirectory(directory, nextCurrentId);

                    return { deletedIds, failedIds };
                },

                archiveSession: async (id: string) => {
                    const { archivedIds, failedIds } = await get().archiveSessions([id]);
                    return archivedIds.length === 1 && failedIds.length === 0;
                },

                archiveSessions: async (ids: string[], options?: { silent?: boolean }) => {
                    const uniqueIds = Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
                    if (uniqueIds.length === 0) {
                        return { archivedIds: [], failedIds: [] };
                    }

                    const silent = options?.silent === true;
                    if (!silent) {
                        set({ isLoading: true, error: null });
                    }

                    const archivedIds: string[] = [];
                    const failedIds: string[] = [];

                    for (const id of uniqueIds) {
                        try {
                            const metadata = get().worktreeMetadata.get(id);
                            const sessionDirectory = getSessionDirectory([...get().sessions, ...get().archivedSessions], id);
                            const requestDirectory = normalizePath(metadata?.projectDirectory ?? null)
                                ?? normalizePath(sessionDirectory)
                                ?? normalizePath(opencodeClient.getDirectory() ?? null)
                                ?? null;
                            const archived = await setSessionArchivedOnServer(id, Date.now(), requestDirectory);
                            if (!archived) {
                                failedIds.push(id);
                                continue;
                            }
                            archivedIds.push(id);
                        } catch {
                            failedIds.push(id);
                        }
                    }

                    const archivedSet = new Set(archivedIds);
                    let nextCurrentId: string | null = null;
                    const errorMessage = failedIds.length > 0
                        ? (failedIds.length === uniqueIds.length ? "Failed to archive sessions" : "Failed to archive some sessions")
                        : null;

                    set((state) => {
                        if (archivedSet.size === 0) {
                            return silent ? state : { ...state, isLoading: false, error: errorMessage };
                        }

                        const archivedRows = state.sessions.filter((session) => archivedSet.has(session.id)).map((session) => ({
                            ...session,
                            time: {
                                ...session.time,
                                archived: Date.now(),
                            },
                        } as Session));

                        const remaining = state.sessions.filter((session) => !archivedSet.has(session.id));
                        const nextArchivedSessions = dedupeSessionsById([...archivedRows, ...state.archivedSessions]);

                        if (state.currentSessionId && archivedSet.has(state.currentSessionId)) {
                            nextCurrentId = remaining[0]?.id ?? null;
                        } else {
                            nextCurrentId = state.currentSessionId;
                        }

                        return {
                            sessions: remaining,
                            archivedSessions: nextArchivedSessions,
                            sessionsByDirectory: buildSessionsByDirectory(remaining),
                            currentSessionId: nextCurrentId,
                            ...(silent ? {} : { isLoading: false, error: errorMessage }),
                        };
                    });

                    if (!silent && archivedSet.size === 0) {
                        set({ isLoading: false, error: errorMessage });
                    }

                    return { archivedIds, failedIds };
                },

                updateSessionTitle: async (id: string, title: string) => {
                    try {
                        const sessionDirectory = getSessionDirectory(get().sessions, id);
                        const metadata = get().worktreeMetadata.get(id);
                        const updateRequest = () => opencodeClient.updateSession(id, title);
                        const overrideDirectory = metadata?.path ?? sessionDirectory;
                        const updatedSession = overrideDirectory
                            ? await opencodeClient.withDirectory(overrideDirectory, updateRequest)
                            : await updateRequest();
                        set((state) => {
                            const sessions = state.sessions.map((s) => (s.id === id ? updatedSession : s));
                            return { sessions, sessionsByDirectory: buildSessionsByDirectory(sessions) };
                        });
                    } catch (error) {
                        set({
                            error: error instanceof Error ? error.message : "Failed to update session title",
                        });
                    }
                },

                shareSession: async (id: string) => {
                    try {
                        const sessionDirectory = getSessionDirectory(get().sessions, id);
                        const apiClient = opencodeClient.getApiClient();
                        const metadata = get().worktreeMetadata.get(id);
                        const overrideDirectory = metadata?.path ?? sessionDirectory;
                        const shareRequest = async () => {
                            const directory = sessionDirectory ?? opencodeClient.getDirectory();
                            return apiClient.session.share({
                                sessionID: id,
                                ...(directory ? { directory } : {})
                            });
                        };
                        const response = overrideDirectory
                            ? await opencodeClient.withDirectory(overrideDirectory, shareRequest)
                            : await shareRequest();

                        if (response.data) {
                            set((state) => {
                                const sessions = state.sessions.map((s) => (s.id === id ? response.data : s));
                                return { sessions, sessionsByDirectory: buildSessionsByDirectory(sessions) };
                            });
                            return response.data;
                        }
                        return null;
                    } catch (error) {
                        set({
                            error: error instanceof Error ? error.message : "Failed to share session",
                        });
                        return null;
                    }
                },

                unshareSession: async (id: string) => {
                    try {
                        const sessionDirectory = getSessionDirectory(get().sessions, id);
                        const apiClient = opencodeClient.getApiClient();
                        const metadata = get().worktreeMetadata.get(id);
                        const overrideDirectory = metadata?.path ?? sessionDirectory;
                        const unshareRequest = async () => {
                            const directory = sessionDirectory ?? opencodeClient.getDirectory();
                            return apiClient.session.unshare({
                                sessionID: id,
                                ...(directory ? { directory } : {})
                            });
                        };
                        const response = overrideDirectory
                            ? await opencodeClient.withDirectory(overrideDirectory, unshareRequest)
                            : await unshareRequest();

                        if (response.data) {
                            set((state) => {
                                const sessions = state.sessions.map((s) => (s.id === id ? response.data : s));
                                return { sessions, sessionsByDirectory: buildSessionsByDirectory(sessions) };
                            });
                            return response.data;
                        }
                        return null;
                    } catch (error) {
                        set({
                            error: error instanceof Error ? error.message : "Failed to unshare session",
                        });
                        return null;
                    }
                },

                setCurrentSession: (id: string | null) => {
                    const prevSessionId = get().currentSessionId;
                    set({ currentSessionId: id, error: null });

                    // Notify server of view state changes
                    // This enables server-side needs_attention tracking
                    if (prevSessionId && prevSessionId !== id) {
                        // Leaving previous session
                        fetch(`/api/sessions/${prevSessionId}/unview`, { method: 'POST' })
                            .catch(() => { /* ignore */ });
                    }
                    if (id) {
                        // Entering new session
                        fetch(`/api/sessions/${id}/view`, { method: 'POST' })
                            .catch(() => { /* ignore */ });
                    }

                    // Trigger immediate poll to get latest attention states
                    // This prevents stale state when switching sessions
                    triggerSessionStatusPoll();

                    const directory = opencodeClient.getDirectory() ?? null;
                    storeSessionForDirectory(directory, id);
                },

                clearError: () => {
                    set({ error: null });
                },

                getSessionsByDirectory: (directory: string) => {
                    const normalized = normalizePath(directory) ?? directory;
                    const { sessionsByDirectory, sessions } = get();

                    const direct = sessionsByDirectory.get(normalized);
                    if (direct) {
                        return direct;
                    }

                    return sessions.filter((session) => {
                        const dir = normalizePath((session as { directory?: string | null }).directory ?? null);
                        return (dir ?? normalized) === normalized;
                    });
                },

                getDirectoryForSession: (sessionId: string) => {
                    if (!sessionId) {
                        return null;
                    }

                    const metadata = get().worktreeMetadata.get(sessionId);
                    if (metadata?.path) {
                        return normalizePath(metadata.path) ?? metadata.path;
                    }

                    const entry = get().sessions.find((session) => session.id === sessionId) as { directory?: string | null } | undefined;
                    const directory = normalizePath(entry?.directory ?? null);
                    return directory;
                },

                applySessionMetadata: (sessionId, metadata) => {
                    if (!sessionId || !metadata) {
                        return;
                    }

                    set((state) => {
                        const index = state.sessions.findIndex((session) => session.id === sessionId);
                        if (index === -1) {
                            return state;
                        }

                        const existingSession = state.sessions[index];
                        const mergedTime = metadata.time
                            ? { ...existingSession.time, ...metadata.time }
                            : existingSession.time;
                        const mergedSummary =
                            metadata.summary === undefined
                                ? existingSession.summary
                                : metadata.summary || undefined;
                        const mergedShare =
                            metadata.share === undefined
                                ? existingSession.share
                                : metadata.share || undefined;

                        const mergedSession: Session = {
                            ...existingSession,
                            ...metadata,
                            time: mergedTime,
                            summary: mergedSummary,
                            share: mergedShare,
                        };

                        const hasChanged =
                            mergedSession.title !== existingSession.title ||
                            mergedSession.parentID !== existingSession.parentID ||
                            mergedSession.directory !== existingSession.directory ||
                            mergedSession.version !== existingSession.version ||
                            mergedSession.projectID !== existingSession.projectID ||
                            JSON.stringify(mergedSession.time) !== JSON.stringify(existingSession.time) ||
                            JSON.stringify(mergedSession.summary ?? null) !== JSON.stringify(existingSession.summary ?? null) ||
                            JSON.stringify(mergedSession.share ?? null) !== JSON.stringify(existingSession.share ?? null);

                        const sessions = [...state.sessions];
                        sessions[index] = hasChanged ? mergedSession : existingSession;

                        return {
                            sessions,
                            sessionsByDirectory: buildSessionsByDirectory(sessions),
                        };
                    });
                },

                isOpenChamberCreatedSession: (sessionId: string) => {
                    const { webUICreatedSessions } = get();
                    return webUICreatedSessions.has(sessionId);
                },

                markSessionAsOpenChamberCreated: (sessionId: string) => {
                    set((state) => {
                        const newOpenChamberCreatedSessions = new Set(state.webUICreatedSessions);
                        newOpenChamberCreatedSessions.add(sessionId);
                        return {
                            webUICreatedSessions: newOpenChamberCreatedSessions,
                        };
                    });
                },

                initializeNewOpenChamberSession: (sessionId: string) => {
                    const { markSessionAsOpenChamberCreated } = get();

                    markSessionAsOpenChamberCreated(sessionId);

                },

                setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null) => {
                    if (!sessionId) {
                        return;
                    }
                    set((state) => {
                        const next = new Map(state.worktreeMetadata);
                        if (metadata) {
                            next.set(sessionId, metadata);
                        } else {
                            next.delete(sessionId);
                        }
                        return { worktreeMetadata: next };
                    });
                },

                getWorktreeMetadata: (sessionId: string) => {
                    if (!sessionId) {
                        return undefined;
                    }
                    return get().worktreeMetadata.get(sessionId);
                },

                setSessionDirectory: (sessionId: string, directory: string | null) => {
                    if (!sessionId) {
                        return;
                    }

                    const currentSessions = get().sessions;
                    const targetIndex = currentSessions.findIndex((session) => session.id === sessionId);
                    if (targetIndex === -1) {
                        return;
                    }

                    const existingSession = currentSessions[targetIndex];
                    const previousDirectory = existingSession.directory ?? null;
                    const normalizedDirectory = directory ?? undefined;

                    if (previousDirectory === (normalizedDirectory ?? null)) {
                        return;
                    }

                    set((state) => {
                        const sessions = [...state.sessions];
                        const updatedSession = { ...sessions[targetIndex] } as Record<string, unknown>;
                        if (normalizedDirectory !== undefined) {
                            updatedSession.directory = normalizedDirectory;
                        } else {
                            delete updatedSession.directory;
                        }
                        sessions[targetIndex] = updatedSession as Session;
                        return { sessions, sessionsByDirectory: buildSessionsByDirectory(sessions) };
                    });

                    if (previousDirectory) {
                        storeSessionForDirectory(previousDirectory, null);
                    }
                    if (directory) {
                        storeSessionForDirectory(directory, sessionId);
                    }

                },

                updateSession: (session: Session) => {
                    set((state) => {
                        const index = state.sessions.findIndex((s) => s.id === session.id);
                        const archivedIndex = state.archivedSessions.findIndex((s) => s.id === session.id);
                        const isArchived = Boolean(session.time?.archived);

                        const nextSessions = index === -1
                            ? (isArchived ? state.sessions : [session, ...state.sessions])
                            : state.sessions.map((s) => (s.id === session.id ? session : s));

                        const nextArchivedSessions = archivedIndex === -1
                            ? (isArchived ? [session, ...state.archivedSessions] : state.archivedSessions)
                            : state.archivedSessions.map((s) => (s.id === session.id ? session : s));

                        const deduped = dedupeSessionsById(nextSessions.filter((item) => !item.time?.archived));
                        const dedupedArchived = dedupeSessionsById(nextArchivedSessions.filter((item) => Boolean(item.time?.archived)));

                        return {
                            sessions: deduped,
                            archivedSessions: dedupedArchived,
                            sessionsByDirectory: buildSessionsByDirectory(deduped),
                        };
                    });
                },

                removeSessionFromStore: (sessionId: string) => {
                    if (!sessionId) {
                        return;
                    }

                    set((state) => {
                        const target = [...state.sessions, ...state.archivedSessions]
                            .find((session) => session.id === sessionId) as { directory?: string | null } | undefined;
                        const directory = normalizePath(target?.directory ?? null);

                        const filteredSessions = state.sessions.filter((session) => session.id !== sessionId);
                        const filteredArchivedSessions = state.archivedSessions.filter((session) => session.id !== sessionId);
                        if (filteredSessions.length === state.sessions.length && filteredArchivedSessions.length === state.archivedSessions.length) {
                            return state;
                        }

                        const nextMetadata = new Map(state.worktreeMetadata);
                        nextMetadata.delete(sessionId);

                        const nextCurrentId = state.currentSessionId === sessionId ? null : state.currentSessionId;

                        if (directory) {
                            storeSessionForDirectory(directory, null);
                        }

                        return {
                            sessions: filteredSessions,
                            archivedSessions: filteredArchivedSessions,
                            sessionsByDirectory: buildSessionsByDirectory(filteredSessions),
                            currentSessionId: nextCurrentId,
                            worktreeMetadata: nextMetadata,
                        };
                    });
                },
            }),
            {
                name: "session-store",
                storage: createJSONStorage(() => getSafeStorage()),
    partialize: (state) => ({
        currentSessionId: state.currentSessionId,
        sessions: state.sessions,
        archivedSessions: state.archivedSessions,
        lastLoadedDirectory: state.lastLoadedDirectory,
        webUICreatedSessions: Array.from(state.webUICreatedSessions),
        worktreeMetadata: Array.from(state.worktreeMetadata.entries()),
        availableWorktrees: state.availableWorktrees,
        availableWorktreesByProject: Array.from(state.availableWorktreesByProject.entries()),
    }),
    merge: (persistedState, currentState) => {
        const isRecord = (value: unknown): value is Record<string, unknown> =>
            typeof value === "object" && value !== null;

        if (!isRecord(persistedState)) {
            return currentState;
        }

        const persistedSessions = Array.isArray(persistedState.sessions)
            ? (persistedState.sessions as Session[])
            : currentState.sessions;
        const persistedArchivedSessions = Array.isArray(persistedState.archivedSessions)
            ? (persistedState.archivedSessions as Session[])
            : currentState.archivedSessions;

        const persistedCurrentSessionId =
            typeof persistedState.currentSessionId === "string" || persistedState.currentSessionId === null
                ? (persistedState.currentSessionId as string | null)
                : currentState.currentSessionId;

        const webUiSessionsArray = Array.isArray(persistedState.webUICreatedSessions)
            ? (persistedState.webUICreatedSessions as string[])
            : [];

        const persistedWorktreeEntries = Array.isArray(persistedState.worktreeMetadata)
            ? (persistedState.worktreeMetadata as Array<[string, WorktreeMetadata]>)
            : [];

        const persistedAvailableWorktrees = Array.isArray(persistedState.availableWorktrees)
            ? (persistedState.availableWorktrees as WorktreeMetadata[])
            : currentState.availableWorktrees;

        const persistedWorktreesByProjectEntries = Array.isArray(persistedState.availableWorktreesByProject)
            ? (persistedState.availableWorktreesByProject as Array<[string, WorktreeMetadata[]]>)
            : [];
        const persistedWorktreesByProject = new Map(persistedWorktreesByProjectEntries);

        const lastLoadedDirectory =
            typeof persistedState.lastLoadedDirectory === "string"
                ? persistedState.lastLoadedDirectory
                : currentState.lastLoadedDirectory ?? null;

        const mergedSessions = dedupeSessionsById(persistedSessions);
        const mergedArchivedSessions = dedupeSessionsById(persistedArchivedSessions);

        const mergedResult = {
            ...currentState,
            ...persistedState,
            sessions: mergedSessions,
            archivedSessions: mergedArchivedSessions,
            sessionsByDirectory: buildSessionsByDirectory(mergedSessions),
            currentSessionId: persistedCurrentSessionId,
            webUICreatedSessions: new Set(webUiSessionsArray),
            worktreeMetadata: new Map(persistedWorktreeEntries),
            availableWorktrees: persistedAvailableWorktrees,
            availableWorktreesByProject: persistedWorktreesByProject.size > 0
                ? persistedWorktreesByProject
                : currentState.availableWorktreesByProject,
            lastLoadedDirectory,
        };
        return mergedResult;
    },
            }
        ),
        {
            name: "session-store",
        }
    )
);
