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
// sessionStore removed — sync bootstrap handles session loading
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';

/**
 * Generate a git-safe slug from a string.
 */
const toGitSafeSlug = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
};

/**
 * Generate a model slug from provider and model IDs.
 */
const toModelSlug = (providerID: string, modelID: string): string => {
  const provider = toGitSafeSlug(providerID);
  const model = toGitSafeSlug(modelID);
  return `${provider}-${model}`.substring(0, 60);
};

/**
 * Seed name for worktree creation.
 * Uses slashes for readability; create payload will slugify.
 */
const generateWorktreeNameSeed = (groupSlug: string, modelSlug: string): string => {
  return `${groupSlug}/${modelSlug}`;
};

const resolveActiveProject = (): ProjectRef | null => {
  const projectsState = useProjectsStore.getState();
  const activeProjectId = projectsState.activeProjectId;
  if (!activeProjectId) {
    return null;
  }

  const project = projectsState.projects.find((entry) => entry.id === activeProjectId);
  if (project?.path) {
    return { id: project.id, path: project.path };
  }

  // Fall back to current directory only when active project is missing.
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
  /** Create worktrees/sessions and immediately start all runs */
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
        const prompt = params.prompt.trim();
        const { models, agent, files, setupCommands } = params;

        if (!groupName) {
          set({ error: 'Group name is required' });
          return null;
        }

        if (!prompt) {
          set({ error: 'Prompt is required' });
          return null;
        }

        if (models.length < 1) {
          set({ error: 'Select at least 1 model' });
          return null;
        }

        if (models.length > 5) {
          set({ error: 'Maximum 5 models allowed' });
          return null;
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
          }> = [];

          const commandsToRun = setupCommands?.filter((cmd) => cmd.trim().length > 0) ?? [];

          // Count occurrences of each model to handle duplicates
          const modelCounts = new Map<string, number>();
          for (const model of models) {
            const key = `${model.providerID}:${model.modelID}`;
            modelCounts.set(key, (modelCounts.get(key) || 0) + 1);
          }

          // Track current index per model during iteration
          const modelIndexes = new Map<string, number>();

          // 1) Create isolated worktrees for Git projects, or same-directory sessions otherwise.
          for (const model of models) {
            const key = `${model.providerID}:${model.modelID}`;
            const count = modelCounts.get(key) || 1;
            const index = (modelIndexes.get(key) || 0) + 1;
            modelIndexes.set(key, index);

            const modelSlug = toModelSlug(model.providerID, model.modelID);
            // Append index only when same model is selected multiple times
            const preferredName = count > 1
              ? generateWorktreeNameSeed(groupSlug, `${modelSlug}/${index}`)
              : generateWorktreeNameSeed(groupSlug, modelSlug);
            try {
              // Session title format: groupSlug/provider/model (or groupSlug/provider/model/index for duplicates)
              const sessionTitle = count > 1
                ? `${groupSlug}/${model.providerID}/${model.modelID}/${index}`
                : `${groupSlug}/${model.providerID}/${model.modelID}`;

              if (!shouldIsolateRuns) {
                const session = await opencodeClient.withDirectory(
                  directory,
                  () => opencodeClient.createSession({ title: sessionTitle })
                );

                createdRuns.push({
                  sessionId: session.id,
                  worktreePath: directory,
                  providerID: model.providerID,
                  modelID: model.modelID,
                  variant: model.variant,
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
                () => opencodeClient.createSession({ title: sessionTitle })
              );

              useSessionUIStore.getState().setWorktreeMetadata(session.id, enrichedMetadata);

              createdRuns.push({
                sessionId: session.id,
                worktreePath: worktreeMetadata.path,
                providerID: model.providerID,
                modelID: model.modelID,
                variant: model.variant,
              });

            } catch (error) {
              // Best-effort: allow partial success
              console.warn('[MultiRun] Failed to create session:', error);
            }
          }

          // Save setup commands to config if any were provided (for future worktree creation)
          const commandsToSave = setupCommands?.filter(cmd => cmd.trim().length > 0) ?? [];
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

          // 2) Start all runs with the same prompt.
          // IMPORTANT: do not await model/agent execution here; only worktree + session creation.
          // Convert files to the format expected by sendMessage
          const filesForMessage = files?.map((f) => ({
            type: 'file' as const,
            mime: f.mime,
            filename: f.filename,
            url: f.url,
          }));

          // Session list refresh handled by sync bootstrap via SSE events

          // Setup commands run via SDK worktree startCommand.

          void (async () => {
            try {
              await Promise.allSettled(
                createdRuns.map(async (run) => {
                  try {
                      await opencodeClient.withDirectory(run.worktreePath, () =>
                       opencodeClient.sendMessage({
                         id: run.sessionId,
                         providerID: run.providerID,
                         modelID: run.modelID,
                         variant: run.variant,
                         text: prompt,
                         agent,
                         files: filesForMessage,
                       })
                     );
                  } catch (error) {
                    console.warn('[MultiRun] Failed to start run:', error);
                  }
                })
              );
            } catch (error) {
              console.warn('[MultiRun] Failed to start runs:', error);
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
    { name: 'multirun-store' }
  )
);
