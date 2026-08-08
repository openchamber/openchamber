import { onCommand } from './api/bridge';
import { usePermissionStore } from '@openchamber/ui/stores/permissionStore';
import type { VSCodeActiveEditorFile } from '@/sync/input-store';

export const registerWebviewCommandHandlers = (): void => {
  onCommand('addContextSelection', (payload) => {
    const { filePath, filename, text } = payload as { filePath?: unknown; filename?: unknown; text?: unknown };
    if (typeof filePath !== 'string' || typeof filename !== 'string' || typeof text !== 'string') {
      return;
    }

    const trimmedPath = filePath.trim();
    const trimmedFilename = filename.trim();
    if (!trimmedPath || !trimmedFilename || !text.trim()) {
      return;
    }

    import('@/sync/input-store').then(({ useInputStore }) => {
      const file = new File([new Blob([text], { type: 'text/plain' })], trimmedFilename, { type: 'text/plain' });
      void useInputStore.getState().addVSCodeSelectionAttachment(trimmedPath, file);
    });
  });

  onCommand('addFileMentions', (payload) => {
    const rawPaths = Array.isArray((payload as { paths?: unknown[] })?.paths)
      ? (payload as { paths: unknown[] }).paths
      : [];
    const paths = rawPaths
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (paths.length === 0) {
      return;
    }

    const mentionText = paths.map((relativePath) => `@${relativePath}`).join(' ');

    import('@/sync/input-store').then(({ useInputStore }) => {
      useInputStore.getState().setPendingInputText(mentionText, 'append-inline');
    });
  });

  onCommand('addFileAttachments', (payload) => {
    const rawFiles = Array.isArray((payload as { files?: unknown[] })?.files)
      ? (payload as { files: unknown[] }).files
      : [];

    const files = rawFiles
      .map((entry) => {
        const record = entry as { filePath?: unknown; fileName?: unknown; fileSize?: unknown };
        const filePath = typeof record.filePath === 'string' ? record.filePath.trim() : '';
        const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
        const fileSize = typeof record.fileSize === 'number' && Number.isFinite(record.fileSize) ? record.fileSize : null;
        return filePath && fileName ? { filePath, fileName, fileSize } : null;
      })
      .filter((entry): entry is { filePath: string; fileName: string; fileSize: number | null } => entry !== null);

    if (files.length === 0) {
      return;
    }

    import('@/sync/input-store').then(({ useInputStore }) => {
      const inputStore = useInputStore.getState();
      for (const file of files) {
        inputStore.addVSCodeFileAttachment(file.filePath, file.fileName, file.fileSize);
      }
    });
  });

  // Listen for createSessionWithPrompt command from extension (Explain, Improve Code)
  onCommand('createSessionWithPrompt', (payload) => {
    const { prompt } = payload as { prompt: string };

    Promise.all([
      import('@/sync/session-ui-store'),
      import('@/stores/useConfigStore'),
      import('@/sync/input-store'),
    ]).then(([{ useSessionUIStore }, { useConfigStore }, { useInputStore }]) => {
      const sessionStore = useSessionUIStore.getState();
      const configStore = useConfigStore.getState();

      // Get current provider/model/agent configuration
      const { currentProviderId, currentModelId, currentAgentName } = configStore;

      if (currentProviderId && currentModelId) {
        if (!sessionStore.currentSessionId) {
          sessionStore.openNewSessionDraft();
        }

        // Send the message - this will create the session from the draft and send
        sessionStore.sendMessage(
          prompt,
          currentProviderId,
          currentModelId,
          currentAgentName ?? undefined,
          undefined, // attachments
          undefined, // agentMentionName
          undefined  // additionalParts
        ).catch((error: unknown) => {
          console.error('[OpenChamber] Failed to send prompt:', error);
        });
      } else {
        // If no provider/model configured, just set the text and let user send manually
        useInputStore.getState().setPendingInputText(prompt);
      }
    });
  });

  const normalizeWorkspaceFoldersPayload = (value: unknown): Array<{ name: string; path: string }> => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        const candidate = entry as { name?: unknown; path?: unknown };
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
        return path ? { name, path } : null;
      })
      .filter((entry): entry is { name: string; path: string } => entry !== null);
  };

  const syncVSCodeWorkspaceProjects = async (
    workspaceFolders: Array<{ name: string; path: string }>,
    activePath?: string,
  ) => {
    if (window.__VSCODE_CONFIG__) {
      window.__VSCODE_CONFIG__.workspaceFolders = workspaceFolders;
    }
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    return useProjectsStore.getState().syncVSCodeWorkspaceFolders(workspaceFolders, activePath);
  };

  onCommand('workspaceFoldersChanged', (payload) => {
    const record = payload as { workspaceFolders?: unknown } | undefined;
    const workspaceFolders = normalizeWorkspaceFoldersPayload(record?.workspaceFolders);
    void syncVSCodeWorkspaceProjects(workspaceFolders);
  });

  // Listen for newSession command from extension title bar button
  onCommand('newSession', (payload) => {
    const record = payload as { directory?: unknown; workspaceFolders?: unknown } | undefined;
    const directory = record?.directory;
    const directoryOverride = typeof directory === 'string' && directory.trim().length > 0 ? directory.trim() : undefined;
    const workspaceFolders = normalizeWorkspaceFoldersPayload(record?.workspaceFolders);

    Promise.all([
      import('@/sync/session-ui-store'),
      syncVSCodeWorkspaceProjects(workspaceFolders, directoryOverride),
    ]).then(([{ useSessionUIStore }, selectedProject]) => {
      useSessionUIStore.getState().openNewSessionDraft(
        directoryOverride
          ? { directoryOverride, selectedProjectId: selectedProject?.id ?? undefined }
          : undefined
      );
    });

    // Also dispatch event to navigate to chat view in VSCodeLayout
    window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
  });

  // Listen for showSettings command from extension title bar button
  onCommand('showSettings', () => {
    // Dispatch event to navigate to settings view in VSCodeLayout
    window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'settings' } }));
  });

  // Run the same full OpenCode reload flow the app uses after an update: shows the
  // reload overlay, restarts the managed OpenCode (via the bridge's /api/config/reload),
  // and refreshes config/data. Triggered by the "Restart API Connection" command.
  onCommand('reloadOpenCode', () => {
    void import('@openchamber/ui/stores/useAgentsStore').then(({ reloadOpenCodeConfiguration }) => {
      void reloadOpenCodeConfiguration().catch(() => undefined);
    });
  });

  // Listen for settings sync command from extension (broadcast to all VS Code webviews)
  onCommand('settingsSynced', () => {
    import('@openchamber/ui/lib/persistence').then(({ syncDesktopSettings }) => {
      void syncDesktopSettings();
    });
  });

  onCommand('permissionAutoAcceptSynced', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const snapshot = payload as { sessions?: unknown; revision?: unknown };
    const sessions = snapshot.sessions;
    if (!sessions || typeof sessions !== 'object') return;
    usePermissionStore.getState().applySnapshot({
      sessions: sessions as Record<string, boolean>,
      revision: typeof snapshot.revision === 'number' ? snapshot.revision : undefined,
    });
  });

  // Listen for active editor file changes from the extension
  onCommand('activeEditorFile', (payload) => {
    import('@/sync/input-store').then(({ useInputStore }) => {
      useInputStore.getState().setActiveEditorFile((payload as VSCodeActiveEditorFile | null) ?? null);
    });
  });
};
