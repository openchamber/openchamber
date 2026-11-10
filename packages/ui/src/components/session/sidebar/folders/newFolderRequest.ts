import { create } from 'zustand';

type NewFolderRequest = { projectLabel: string | null; create: (name: string) => void };

export const useNewFolderRequest = create<{ request: NewFolderRequest | null }>(() => ({ request: null }));

/**
 * Asks for a new folder's name. For a row with no folder row in reach to rename
 * in place: a folder made from the list by time would stay named "New folder".
 */
export const requestNewFolder = (request: NewFolderRequest): void => useNewFolderRequest.setState({ request });

export const closeNewFolderRequest = (): void => useNewFolderRequest.setState({ request: null });
