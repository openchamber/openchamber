import { create } from 'zustand';

type NewFolderRequest = { projectLabel: string | null; create: (name: string) => void };

export const useNewFolderRequest = create<{ request: NewFolderRequest | null }>(() => ({ request: null }));

export const requestNewFolder = (request: NewFolderRequest): void => useNewFolderRequest.setState({ request });

export const closeNewFolderRequest = (): void => useNewFolderRequest.setState({ request: null });
