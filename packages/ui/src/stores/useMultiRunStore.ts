import { create } from 'zustand';
import type { Session } from '@/lib/opencode/model';
import { routeMessage, useSessionUIStore } from '@/sync/session-ui-store';
import { devtools } from 'zustand/middleware';
import type { CreateMultiRunParams, CreateMultiRunResult } from '@/types/multirun';
import { opencodeClient } from '@/lib/opencode/client';
import { fetchSessionKnowledge, reportSessionKnowledgeDelivered } from '@/lib/sessionKnowledgeApi';
import { getWorktreeSetupWaitEnabled, saveWorktreeSetupCommands } from '@/lib/openchamberConfig';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { createWorktreeWithDefaults, resolveRootTrackingRemote } from '@/lib/worktrees/worktreeCreate';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { checkIsGitRepository } from '@/lib/gitApi';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { useSnippetsStore } from './useSnippetsStore';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { getMultiRunSessionTitle } from '@/lib/multirun/title';
import { createMultiRunSession } from '@/lib/multirun/createSession';
import { multiRunGroupKey, type MultiRunMembership } from '@/lib/multirun/identity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSyncChildStores, registerSessionDirectory } from '@/sync/sync-refs';

const toGitSafeSlug = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
};

const toModelSlug = (providerID: string, modelID: string): string => {
  const provider = toGitSafeSlug(providerID);
  const model = toGitSafeSlug(modelID);
  return `${provider}-${model}`.substring(0, 60);
};

const generateWorktreeNameSeed = (groupSlug: string, modelSlug: string): string => {
  return `${groupSlug}/${modelSlug}`;
};

const normalizePath = (value: string): string => {
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

export const registerMultiRunSession = (session: Session, directory: string): Session => {
  const normalizedDirectory = normalizePath(directory);
  const sessionWithDirectory = session.directory?.trim()
    ? session
    : { ...session, directory: normalizedDirectory };

  registerSessionDirectory(session.id, normalizedDirectory);
  useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id);
  useGlobalSessionsStore.getState().upsertSession(sessionWithDirectory);

  try {
    const store = getSyncChildStores().ensureChild(normalizedDirectory, { bootstrap: false });
    store.setState((state) => {
      const existingIndex = state.session.findIndex((candidate) => candidate.id === session.id);
      if (existingIndex >= 0 && state.session[existingIndex] === sessionWithDirectory) {
        return state;
      }

      const nextSessions = existingIndex >= 0
        ? state.session.map((candidate, index) => index === existingIndex ? sessionWithDirectory : candidate)
        : [...state.session, sessionWithDirectory].sort((a, b) => a.id.localeCompare(b.id));

      return {
        session: nextSessions,
        sessionTotal: Math.max(state.sessionTotal, nextSessions.length),
        limit: Math.max(state.limit, nextSessions.length),
      };
    });
  } catch {
    // SyncProvider can be unavailable in tests or detached surfaces; the global
    // session upsert above is enough for the sidebar to show the session.
  }

  return sessionWithDirectory;
};

const resolveActiveProject = (): ProjectRef | null => {
  const projectsState = useProjectsStore.getState();
  const activeProjectId = projectsState.activeProjectId;
  if (!activeProjectId) return null;

  const project = projectsState.projects.find((entry) => entry.id === activeProjectId);
  if (project?.path) return { id: project.id, path: project.path };

  const currentDirectory = useDirectoryStore.getState().currentDirectory ?? null;
  if (currentDirectory && currentDirectory.trim().length > 0) {
    const normalized = currentDirectory.replace(/\\/g, '/').replace(/\/+$/, '') || currentDirectory;
    return { id: `path:${normalized}`, path: normalized };
  }

  return null;
};

interface MultiRunState {
  isLoading: boolean;
  error: string | null;
}

interface MultiRunActions {
  createMultiRun: (params: CreateMultiRunParams) => Promise<CreateMultiRunResult | null>;
  clearError: () => void;
  resetForRuntimeSwitch: () => void;
}

type MultiRunStore = MultiRunState & MultiRunActions;

export const useMultiRunStore = create<MultiRunStore>()(
  devtools(
    (set) => ({
      isLoading: false,
      error: null,

      createMultiRun: async (params: CreateMultiRunParams) => {
        const runtimeKey = getRuntimeKey();
        const client = opencodeClient.getSdkClient();
        const assertCurrent = () => {
          if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
        };
        const groupName = params.name.trim();
        const { groups, agent, files, setupCommands } = params;

        if (!groupName) {
          set({ error: 'Group name is required' });
          return null;
        }

        if (!groups || groups.length === 0) {
          set({ error: 'At least one run group is required' });
          return null;
        }

        for (let gi = 0; gi < groups.length; gi++) {
          if (!groups[gi].prompt.trim()) {
            set({ error: `Group ${gi + 1}: prompt is required` });
            return null;
          }
          if (groups[gi].models.length < 1) {
            set({ error: `Group ${gi + 1}: select at least 1 model` });
            return null;
          }
        }

        set({ isLoading: true, error: null });

        try {
          const project = resolveActiveProject();
          if (!project) {
            set({ error: 'Select a project', isLoading: false });
            return null;
          }

          const directory = project.path;

          const isGit = await checkIsGitRepository(directory);
          assertCurrent();
          const shouldIsolateRuns = isGit && params.isolateRuns !== false;

          const groupSlug = toGitSafeSlug(groupName) || 'multi-run';
          const membershipGroup: MultiRunMembership['group'] = { kind: 'id', id: crypto.randomUUID() };
          const rootBranch = shouldIsolateRuns ? await getRootBranch(directory) : undefined;
          assertCurrent();
          const rootTrackingRemote = shouldIsolateRuns ? await resolveRootTrackingRemote(directory) : null;
          assertCurrent();

          const createdRuns: Array<{
            sessionId: string;
            worktreePath: string;
            providerID: string;
            modelID: string;
            variant?: string;
            prompt: string;
          }> = [];

          const commandsToRun = setupCommands?.filter((cmd) => cmd.trim().length > 0) ?? [];

          for (let gi = 0; gi < groups.length; gi++) {
            assertCurrent();
            const group = groups[gi];
            const prompt = group.prompt;

            const modelCounts = new Map<string, number>();
            for (const model of group.models) {
              assertCurrent();
              const key = `${model.providerID}:${model.modelID}`;
              modelCounts.set(key, (modelCounts.get(key) || 0) + 1);
            }

            const modelIndexes = new Map<string, number>();

            for (const model of group.models) {
              const key = `${model.providerID}:${model.modelID}`;
              const count = modelCounts.get(key) || 1;
              const index = (modelIndexes.get(key) || 0) + 1;
              modelIndexes.set(key, index);

              const modelSlug = toModelSlug(model.providerID, model.modelID);
              const runGroup = groups.length > 1 ? `g${gi + 1}` : undefined;
              const modelPart = count > 1
                ? generateWorktreeNameSeed(groupSlug, `${modelSlug}/${index}`)
                : generateWorktreeNameSeed(groupSlug, modelSlug);
              const preferredName = runGroup
                ? `${runGroup}/${modelPart}`
                : modelPart;

              const sessionTitle = getMultiRunSessionTitle({
                groupSlug,
                runGroup,
                providerID: model.providerID,
                modelID: model.modelID,
                index: count > 1 ? index : undefined,
              });

              try {
                const createRun = (runDirectory: string) => createMultiRunSession({
                  title: sessionTitle, directory: runDirectory,
                  identity: { group: membershipGroup, groupSlug, runGroup, providerID: model.providerID,
                    modelID: model.modelID, index: count > 1 ? index : undefined, role: 'run' },
                  selection: { model: { providerID: model.providerID, id: model.modelID, variant: model.variant }, agent },
                }, assertCurrent);
                if (!shouldIsolateRuns) {
                  const session = await createRun(directory);
                  registerMultiRunSession(session, directory);

                  createdRuns.push({
                    sessionId: session.id,
                    worktreePath: directory,
                    providerID: model.providerID,
                    modelID: model.modelID,
                    variant: model.variant,
                    prompt,
                  });
                  continue;
                }

                assertCurrent();
                const worktreeMetadata = await createWorktreeWithDefaults(project, {
                  preferredName,
                  mode: 'new',
                  branchName: preferredName,
                  worktreeName: preferredName,
                  startRef: params.worktreeBaseBranch || 'HEAD',
                  setupCommands: commandsToRun,
                  returnAfterDirectoryCreated: true,
                }, {
                  resolvedRootTrackingRemote: rootTrackingRemote,
                });
                assertCurrent();

                const enrichedMetadata = {
                  ...worktreeMetadata,
                  createdFromBranch: rootBranch,
                  kind: 'standard' as const,
                };

                const waitForSetup = await getWorktreeSetupWaitEnabled(project);
                assertCurrent();
                if (waitForSetup) {
                  await waitForWorktreeBootstrap(worktreeMetadata.path);
                  assertCurrent();
                }

                const session = await createRun(worktreeMetadata.path);
                registerMultiRunSession(session, worktreeMetadata.path);

                useSessionUIStore.getState().setWorktreeMetadata(session.id, enrichedMetadata);

                createdRuns.push({
                  sessionId: session.id,
                  worktreePath: worktreeMetadata.path,
                  providerID: model.providerID,
                  modelID: model.modelID,
                  variant: model.variant,
                  prompt,
                });
              } catch (err) {
                assertCurrent();
                console.warn('[MultiRun] Failed to create session:', err);
              }
            }
          }

          const commandsToSave = setupCommands?.filter((cmd) => cmd.trim().length > 0) ?? [];
          assertCurrent();
          if (commandsToSave.length > 0) {
            saveWorktreeSetupCommands(project, commandsToSave).catch(() => {
              console.warn('[MultiRun] Failed to save worktree setup commands');
            });
          }

          const sessionIds = createdRuns.map((r) => r.sessionId);
          const firstSessionId = createdRuns[0]?.sessionId ?? null;

          if (sessionIds.length === 0) {
            set({ error: 'Failed to create any sessions', isLoading: false });
            return null;
          }

          const filesForMessage = files?.map((f) => ({
            type: 'file' as const,
            mime: f.mime,
            filename: f.filename,
            url: f.url,
          }));

          void (async () => {
            try {
              const expandText = useSnippetsStore.getState().expandText;
              await Promise.allSettled(
                createdRuns.map(async (run) => {
                  try {
                    assertCurrent();
                    // Each run is a fresh session, so it is owed the project's
                    // standing context exactly as a composer send would be.
                    const [text, knowledge] = await Promise.all([
                      expandText(run.prompt).catch(() => run.prompt),
                      fetchSessionKnowledge(run.worktreePath, run.sessionId),
                    ]);
                    assertCurrent();
                    const route = await routeMessage({
                      runtimeKey,
                      sessionId: run.sessionId,
                      directory: run.worktreePath,
                      content: text,
                      providerID: run.providerID,
                      modelID: run.modelID,
                      variant: run.variant,
                      agent,
                      files: filesForMessage,
                      additionalParts: knowledge.text
                        ? [{ text: knowledge.text, synthetic: true, systemContext: 'session-knowledge' }]
                        : undefined,
                    });
                    if (knowledge.text && route !== 'shell') {
                      void reportSessionKnowledgeDelivered(run.worktreePath, run.sessionId, knowledge.signature);
                    }
                  } catch (err) {
                    console.warn('[MultiRun] Failed to start run:', err);
                  }
                }),
              );
            } catch (err) {
              console.warn('[MultiRun] Failed to start runs:', err);
            }
          })();

          set({ isLoading: false });
          const failedCount = groups.reduce((total, group) => total + group.models.length, 0) - sessionIds.length;
          return { groupSlug, groupKey: multiRunGroupKey(membershipGroup, groupSlug), sessionIds, firstSessionId, failedCount };
        } catch (error) {
          if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== client) return null;
          set({
            error: error instanceof Error ? error.message : 'Failed to create Multi-Run',
            isLoading: false,
          });
          return null;
        }
      },

      clearError: () => {
        set({ error: null });
      },
      resetForRuntimeSwitch: () => set({ isLoading: false, error: null }),
    }),
    { name: 'multirun-store' },
  ),
);
