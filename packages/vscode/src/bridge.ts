import * as vscode from 'vscode';
import { type OpenCodeManager } from './opencode';
import { handleStandardGitBridgeMessage } from './bridge-git-runtime';
import { handleSpecialGitBridgeMessage } from './bridge-git-special-runtime';
import { handleSmallModelBridgeMessage, readOpenCodeSmallModelCatalog } from './bridge-small-model-runtime';
import { handleFsBridgeMessage } from './bridge-fs-runtime';
import { handleConfigBridgeMessage } from './bridge-config-runtime';
import { handleSystemBridgeMessage } from './bridge-system-runtime';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';
import { waitForWorktreeRemoval } from './gitService';
import { handlePermissionAutoAcceptBridgeMessage } from './bridge-permission-auto-accept-runtime';
import { handleProjectSetupBridgeMessage } from './bridge-project-setup-runtime';
import { createSessionStateStore, getOpenChamberDataDir } from './openchamberSessionState';
import { openCodeTrust } from './opencodeTrust';
import {
  fetchOpenCodeSkillsFromApi,
  persistSettings,
  readSettings,
  magicPrompts,
  projectSetupStore,
} from './bridge-settings-runtime';
import { execGit } from './bridge-git-process-runtime';
import {
  parseDroppedFileReference,
  readUriAsAttachment,
  resolveUserPath,
  listDirectoryEntries,
  normalizeFsPath,
  searchDirectory,
  resolveFileReadPath,
  fetchModelsMetadata,
} from './bridge-fs-helpers-runtime';
import {
  tryHandleLocalFsProxy,
  buildUnavailableApiResponse,
  sanitizeForwardHeaders,
  collectHeaders,
  base64EncodeUtf8,
} from './bridge-localfs-proxy-runtime';

export interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

export interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export interface BridgeContext {
  manager?: OpenCodeManager;
  context?: vscode.ExtensionContext;
}

const CLIENT_RELOAD_DELAY_MS = 800;
const sessionStateStore = createSessionStateStore({ dataDir: getOpenChamberDataDir() });

const UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL || 'https://api.openchamber.dev/v1/update/check';


export async function handleBridgeMessage(message: BridgeRequest, ctx?: BridgeContext): Promise<BridgeResponse> {
  const { id, type, payload } = message;

  try {
    const permissionAutoAcceptResponse = await handlePermissionAutoAcceptBridgeMessage(
      { id, type, payload },
      ctx?.context,
      {
        broadcast: (snapshot) => vscode.commands.executeCommand(
          'openchamber.internal.permissionAutoAcceptSynced',
          snapshot,
        ),
      },
    );
    if (permissionAutoAcceptResponse) return permissionAutoAcceptResponse;

    const standardGitResponse = await handleStandardGitBridgeMessage({ id, type, payload }, ctx);
    if (standardGitResponse) {
      return standardGitResponse;
    }
    const specialGitResponse = await handleSpecialGitBridgeMessage(
      { id, type, payload },
      ctx,
      { readSettings, execGit, readPromptOverrides: magicPrompts.overridesForDirectory }
    );
    if (specialGitResponse) {
      return specialGitResponse;
    }
    const smallModelResponse = await handleSmallModelBridgeMessage(
      { id, type, payload },
      (directory) => readOpenCodeSmallModelCatalog(ctx?.manager, directory),
    );
    if (smallModelResponse) {
      return smallModelResponse;
    }
    const projectSetupResponse = await handleProjectSetupBridgeMessage({ id, type, payload }, projectSetupStore);
    if (projectSetupResponse) {
      return projectSetupResponse;
    }
    const fsResponse = await handleFsBridgeMessage(
      { id, type, payload },
      {
        resolveUserPath,
        listDirectoryEntries,
        normalizeFsPath,
        execGit,
        searchDirectory,
        resolveFileReadPath,
        parseDroppedFileReference,
        readUriAsAttachment,
      }
    );
    if (fsResponse) {
      return fsResponse;
    }
    const configResponse = await handleConfigBridgeMessage(
      { id, type, payload },
      ctx,
      {
        readSettings,
        persistSettings,
        handleMagicPromptRequest: magicPrompts.handle,
        fetchOpenCodeSkillsFromApi,
        clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      },
    );
    if (configResponse) {
      return configResponse;
    }
    const systemResponse = await handleSystemBridgeMessage(
      { id, type, payload },
      ctx,
      {
        resolveUserPath,
        sessionState: sessionStateStore,
        fetchModelsMetadata,
        updateCheckUrl: UPDATE_CHECK_URL,
        clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      },
    );
    if (systemResponse) {
      return systemResponse;
    }
    const proxyResponse = await handleProxyBridgeMessage(
      { id, type, payload },
      ctx,
      {
        tryHandleLocalFsProxy,
        waitForWorktreeRemoval,
        sessionState: sessionStateStore,
        openCodeTrust,
        buildUnavailableApiResponse,
        sanitizeForwardHeaders,
        collectHeaders,
        base64EncodeUtf8,
      },
    );
    if (proxyResponse) {
      return proxyResponse;
    }

    switch (type) {
      default:
        return { id, type, success: false, error: `Unknown message type: ${type}` };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error && 'code' in err ? String(err.code) : undefined;
    return { id, type, success: false, error: errorMessage, code };
  }
}
