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

// Stub APIs return sensible defaults instead of throwing
const createStubTerminalAPI = (): TerminalAPI => ({
  createSession: async () => ({ sessionId: '', cols: 80, rows: 24 }),
  connect: () => ({ close: () => {} }),
  sendInput: async () => {},
  resize: async () => {},
  close: async () => {},
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
