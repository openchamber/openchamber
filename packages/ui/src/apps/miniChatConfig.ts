type MiniChatMode = 'session' | 'draft';

export type MiniChatConfig = {
  mode: MiniChatMode;
  sessionId: string | null;
  directory: string | null;
  projectId: string | null;
};

/** What the Mini Chat window was opened on, from its URL. */
export const readMiniChatConfig = (): MiniChatConfig => {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const mode = params.get('mode') === 'session' ? 'session' : 'draft';
  const sessionId = params.get('sessionId')?.trim() || null;
  const directory = params.get('directory')?.trim() || null;
  const projectId = params.get('projectId')?.trim() || null;
  return { mode, sessionId, directory, projectId };
};
