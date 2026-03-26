import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

// --- Types ---

export interface ProjectFolder {
  id: string;
  name: string;
  projectIds: string[];
  createdAt: number;
  /** If set, this folder is a sub-folder of the parent folder with this id */
  parentId?: string | null;
}

interface ProjectFoldersState {
  folders: ProjectFolder[];
  collapsedFolderIds: Set<string>;
}

interface ProjectFoldersActions {
  getFolderById: (folderId: string) => ProjectFolder | undefined;
  getUnfolderedProjects: (allProjectIds: string[]) => string[];
  createFolder: (name: string, parentId?: string | null) => ProjectFolder;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  addProjectToFolder: (folderId: string, projectId: string) => void;
  removeProjectFromFolder: (projectId: string) => void;
  moveProjectToFolder: (projectId: string, targetFolderId: string | null) => void;
  toggleFolderCollapse: (folderId: string) => void;
  reorderFolders: (fromIndex: number, toIndex: number) => void;
  moveProjectWithinFolder: (folderId: string, fromIndex: number, toIndex: number) => void;
}

type ProjectFoldersStore = ProjectFoldersState & ProjectFoldersActions;

// --- Store ---

export const useProjectFoldersStore = create<ProjectFoldersStore>()(
  devtools(
    persist(
      (set, get) => ({
        folders: [],
        collapsedFolderIds: new Set<string>(),

        getFolderById: (folderId: string) => {
          return get().folders.find((f) => f.id === folderId);
        },

        getUnfolderedProjects: (allProjectIds: string[]) => {
          const assignedIds = new Set(
            get().folders.flatMap((f) => f.projectIds)
          );
          return allProjectIds.filter((id) => !assignedIds.has(id));
        },

        createFolder: (name: string, parentId?: string | null) => {
          const newFolder: ProjectFolder = {
            id: crypto.randomUUID(),
            name,
            projectIds: [],
            createdAt: Date.now(),
            parentId,
          };
          set((state) => ({ folders: [...state.folders, newFolder] }));
          return newFolder;
        },

        renameFolder: (folderId: string, name: string) => {
          set((state) => ({
            folders: state.folders.map((f) =>
              f.id === folderId ? { ...f, name } : f
            ),
          }));
        },

        deleteFolder: (folderId: string) => {
          set((state) => ({
            folders: state.folders.filter((f) => f.id !== folderId),
            collapsedFolderIds: new Set(
              [...state.collapsedFolderIds].filter((id) => id !== folderId)
            ),
          }));
        },

        addProjectToFolder: (folderId: string, projectId: string) => {
          set((state) => ({
            folders: state.folders.map((f) => {
              if (f.id === folderId && !f.projectIds.includes(projectId)) {
                return { ...f, projectIds: [...f.projectIds, projectId] };
              }
              return f;
            }),
          }));
        },

        removeProjectFromFolder: (projectId: string) => {
          set((state) => ({
            folders: state.folders.map((f) => ({
              ...f,
              projectIds: f.projectIds.filter((id) => id !== projectId),
            })),
          }));
        },

        moveProjectToFolder: (projectId: string, targetFolderId: string | null) => {
          const state = get();
          // Remove from all folders first
          const withoutProject = state.folders.map((f) => ({
            ...f,
            projectIds: f.projectIds.filter((id) => id !== projectId),
          }));
          
          if (targetFolderId) {
            // Add to target folder
            set({
              folders: withoutProject.map((f) =>
                f.id === targetFolderId
                  ? { ...f, projectIds: [...f.projectIds, projectId] }
                  : f
              ),
            });
          } else {
            set({ folders: withoutProject });
          }
        },

        toggleFolderCollapse: (folderId: string) => {
          set((state) => {
            const newSet = new Set(state.collapsedFolderIds);
            if (newSet.has(folderId)) {
              newSet.delete(folderId);
            } else {
              newSet.add(folderId);
            }
            return { collapsedFolderIds: newSet };
          });
        },

        reorderFolders: (fromIndex: number, toIndex: number) => {
          set((state) => {
            const newFolders = [...state.folders];
            const [removed] = newFolders.splice(fromIndex, 1);
            newFolders.splice(toIndex, 0, removed);
            return { folders: newFolders };
          });
        },

        moveProjectWithinFolder: (folderId: string, fromIndex: number, toIndex: number) => {
          set((state) => ({
            folders: state.folders.map((f) => {
              if (f.id === folderId) {
                const newIds = [...f.projectIds];
                const [removed] = newIds.splice(fromIndex, 1);
                newIds.splice(toIndex, 0, removed);
                return { ...f, projectIds: newIds };
              }
              return f;
            }),
          }));
        },
      }),
      {
        name: 'oc.projects.folders',
        partialize: (state) => ({
          folders: state.folders,
        }),
      }
    ),
    { name: 'project-folders-store' }
  )
);
