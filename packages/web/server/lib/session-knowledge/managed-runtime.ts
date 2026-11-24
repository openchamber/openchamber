import { linkedWorktreeOf } from '../openchamber-sessions/work-naming.js';
import { isBridgePluginLoaded } from '../opencode/external-plugin-bridge.js';
import { createSessionKnowledgeRuntime } from './runtime.js';
import type { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import type { SessionKnowledgeDependencies } from './contracts.js';

interface ToolSettings {
  agentControlToolEnabled?: unknown;
  agentRenderToolEnabled?: unknown;
  agentSecretToolEnabled?: unknown;
}

type ManagedKnowledgeDependencies = Pick<SessionKnowledgeDependencies,
  'projectContextRuntime' | 'agentMemoryRuntime' | 'resolveProjectId' | 'readExtensionInstructions' | 'readLeadBrief'
  | 'readCheckoutBranch' | 'readPlaceholderBranch' | 'readSessionMetadata' | 'persistSessionMetadata'> & {
  hasProjectActions: (directory: string) => Promise<boolean>;
  isManagedOpenCode: () => boolean;
  readExternalBridgeToken: () => string | null;
  readSettings: () => Promise<ToolSettings | null>;
  isAgentMemoryEnabled: () => Promise<boolean>;
  isWorkflowToolEnabled: () => Promise<boolean>;
  listWorktrees: (directory: string) => Promise<{ path: string }[]>;
  openCodeSessionClient: (directory: string) => ReturnType<typeof createOpenCodeClient>;
};

const SPACE_DIRECTORY = /^\/spaces\/[0-9a-f]{12}(?:\/|$)/;

export const createManagedSessionKnowledgeRuntime = ({
  isManagedOpenCode,
  readExternalBridgeToken,
  readSettings,
  isAgentMemoryEnabled,
  isWorkflowToolEnabled,
  listWorktrees,
  openCodeSessionClient,
  hasProjectActions,
  ...dependencies
}: ManagedKnowledgeDependencies) => {
  const toolSettingOn = (key: keyof ToolSettings) => async () => {
    const settings = await readSettings().catch(() => null);
    return settings?.[key] !== false;
  };
  const isToolHost = async (directory: string) => {
    if (isManagedOpenCode()) return true;
    const token = readExternalBridgeToken();
    if (!token) return false;
    if (!directory) return null;
    return isBridgePluginLoaded(openCodeSessionClient(directory), token);
  };
  const runtime = createSessionKnowledgeRuntime({
    ...dependencies,
    isAgentMemoryEnabled,
    isToolHost,
    isMemoryToolAvailable: isAgentMemoryEnabled,
    isSessionLinkingAvailable: toolSettingOn('agentControlToolEnabled'),
    isWorkNamingAvailable: async (directory) => {
      if (SPACE_DIRECTORY.test(directory)) return true;
      return linkedWorktreeOf(directory, await listWorktrees(directory)) !== null;
    },
    isPageRenderingAvailable: toolSettingOn('agentRenderToolEnabled'),
    isSecretRequestAvailable: toolSettingOn('agentSecretToolEnabled'),
    isWorkflowAvailable: isWorkflowToolEnabled,
    hasProjectActions,
    instructionEntries: {
      put: (sessionID, directory, key, value) => openCodeSessionClient(directory)
        .experimental.session.instructions.entry.put({ sessionID, key, value }),
      remove: (sessionID, directory, key) => openCodeSessionClient(directory)
        .experimental.session.instructions.entry.remove({ sessionID, key }),
    },
  });
  return { ...runtime, isToolHost };
};
