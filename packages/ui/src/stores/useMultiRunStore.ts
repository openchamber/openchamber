import { create } from 'zustand';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { devtools } from 'zustand/middleware';
import type { CreateMultiRunParams, CreateMultiRunResult } from '@/types/multirun';
import { opencodeClient } from '@/lib/opencode/client';
import { saveWorktreeSetupCommands } from '@/lib/openchamberConfig';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { createWorktreeWithDefaults, resolveRootTrackingRemote } from '@/lib/worktrees/worktreeCreate';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { checkIsGitRepository } from '@/lib/gitApi';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { useSnippetsStore } from './useSnippetsStore';
import { getMultiRunSessionTitle } from '@/lib/multirun/title';

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
}

type MultiRunStore = MultiRunState & MultiRunActions;

export const useMultiRunStore = create<MultiRunStore>()(
  devtools(
    (set) => ({
      isLoading: false,
      error: null,

      createMultiRun: async (params: CreateMultiRunParams) => {
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
          if (groups[gi].models.length > 5) {
            set({ error: `Group ${gi + 1}: maximum 5 models allowed` });
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
          const shouldIsolateRuns = isGit && params.isolateRuns !== false;

          const groupSlug = toGitSafeSlug(groupName);
          const rootBranch = shouldIsolateRuns ? await getRootBranch(directory) : undefined;
          const rootTrackingRemote = shouldIsolateRuns ? await resolveRootTrackingRemote(directory) : null;

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
            const group = groups[gi];
            const prompt = group.prompt;

            const modelCounts = new Map<string, number>();
            for (const model of group.models) {
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
                if (!shouldIsolateRuns) {
                  const session = await opencodeClient.withDirectory(
                    directory,
                    () => opencodeClient.createSession({ title: sessionTitle }),
                  );

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

                const worktreeMetadata = await createWorktreeWithDefaults(project, {
                  preferredName,
                  mode: 'new',
                  branchName: preferredName,
                  worktreeName: preferredName,
                  startRef: params.worktreeBaseBranch || 'HEAD',
                  setupCommands: commandsToRun,
                }, {
                  resolvedRootTrackingRemote: rootTrackingRemote,
                });

                const enrichedMetadata = {
                  ...worktreeMetadata,
                  createdFromBranch: rootBranch,
                  kind: 'standard' as const,
                };

                const session = await opencodeClient.withDirectory(
                  worktreeMetadata.path,
                  () => opencodeClient.createSession({ title: sessionTitle }),
                );

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
                console.warn('[MultiRun] Failed to create session:', err);
              }
            }
          }

          const commandsToSave = setupCommands?.filter((cmd) => cmd.trim().length > 0) ?? [];
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
                    const text = await expandText(run.prompt).catch(() => run.prompt);
                    await opencodeClient.withDirectory(run.worktreePath, () =>
                      opencodeClient.sendMessage({
                        id: run.sessionId,
                        providerID: run.providerID,
                        modelID: run.modelID,
                        variant: run.variant,
                        text,
                        agent,
                        files: filesForMessage,
                      }),
                    );
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
          return { groupSlug, sessionIds, firstSessionId };
        } catch (error) {
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
    }),
    { name: 'multirun-store' },
  ),
);
