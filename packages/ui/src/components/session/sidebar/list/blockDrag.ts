import { create } from 'zustand';

/**
 * What kind of block the user is dragging in the sidebar, if any: a project
 * header or a section's caption. While one is held, the list folds to the
 * headers of that kind, so they slide past each other as single rows do; the
 * rows under them come back on drop (`SessionProjectCollection`).
 */
export const useSidebarBlockDragStore = create<{ kind: 'project' | 'section' | null }>(() => ({ kind: null }));

export const setSidebarBlockDrag = (kind: 'project' | 'section' | null): void => useSidebarBlockDragStore.setState({ kind });
