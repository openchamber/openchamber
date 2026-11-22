import { create } from 'zustand';

type NewFolderRequest = { projectLabel: string | null; create: (name: string) => void };

const useNewFolderRequest = create<{ request: NewFolderRequest | null }>(() => ({ request: null }));

export const requestNewFolder = (request: NewFolderRequest): void => useNewFolderRequest.setState({ request });
