import { create } from 'zustand';

export const useSidebarBlockDragStore = create<{ kind: 'project' | 'section' | null }>(() => ({ kind: null }));

export const setSidebarBlockDrag = (kind: 'project' | 'section' | null): void => useSidebarBlockDragStore.setState({ kind });
