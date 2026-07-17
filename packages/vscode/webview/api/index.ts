import type { RuntimeAPIs, TerminalAPI } from '@openchamber/ui/lib/api/types';
import { createVSCodeFilesAPI } from './files';
import { createVSCodeSettingsAPI } from './settings';
import { createVSCodePermissionsAPI } from './permissions';
import { createVSCodeToolsAPI } from './tools';
import { createVSCodeEditorAPI } from './editor';
import { createVSCodeGitAPI } from './git';
import { createVSCodeActionsAPI } from './vscode';
import { createVSCodeGitHubAPI } from './github';
import { createVSCodeNotificationsAPI } from './notifications';

const terminalUnsupported = async (): Promise<never> => {
  throw new Error('Terminal is not supported in the VS Code runtime');
};

const createStubTerminalAPI = (): TerminalAPI => ({
  listShells: terminalUnsupported,
  createSession: terminalUnsupported,
  connect: (_sessionId, handlers) => {
    handlers.onError?.(new Error('Terminal is not supported in the VS Code runtime'), true);
    return { close: () => {} };
  },
  sendInput: terminalUnsupported,
  resize: terminalUnsupported,
  close: terminalUnsupported,
});

export const createVSCodeAPIs = (): RuntimeAPIs => ({
  runtime: { platform: 'vscode', isDesktop: false, isVSCode: true, label: 'VS Code Extension' },
  terminal: createStubTerminalAPI(),
  git: createVSCodeGitAPI(),
  files: createVSCodeFilesAPI(),
  settings: createVSCodeSettingsAPI(),
  permissions: createVSCodePermissionsAPI(),
  notifications: createVSCodeNotificationsAPI(),
  github: createVSCodeGitHubAPI(),
  tools: createVSCodeToolsAPI(),
  editor: createVSCodeEditorAPI(),
  vscode: createVSCodeActionsAPI(),
});
