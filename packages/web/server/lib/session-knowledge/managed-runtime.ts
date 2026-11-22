import { linkedWorktreeOf } from '../openchamber-sessions/work-naming.js';
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
  isToolHost: () => boolean;
  readSettings: () => Promise<ToolSettings | null>;
  isAgentMemoryEnabled: () => Promise<boolean>;
  isWorkflowToolEnabled: () => Promise<boolean>;
  listWorktrees: (directory: string) => Promise<{ path: string }[]>;
  openCodeSessionClient: (directory: string) => ReturnType<typeof createOpenCodeClient>;
};

const SPACE_DIRECTORY = /^\/spaces\/[0-9a-f]{12}(?:\/|$)/;

export const createManagedSessionKnowledgeRuntime = ({
  isToolHost,
  readSettings,
  isAgentMemoryEnabled,
  isWorkflowToolEnabled,
  listWorktrees,
  openCodeSessionClient,
  ...dependencies
}: ManagedKnowledgeDependencies) => {
  const toolSettingOn = (key: keyof ToolSettings) => async () => {
    if (!isToolHost()) return false;
    const settings = await readSettings().catch(() => null);
    return settings?.[key] !== false;
  };
  return createSessionKnowledgeRuntime({
    ...dependencies,
    isAgentMemoryEnabled,
    isMemoryToolAvailable: async () => isToolHost() && isAgentMemoryEnabled(),
    isSessionLinkingAvailable: toolSettingOn('agentControlToolEnabled'),
    isWorkNamingAvailable: async (directory) => {
      if (SPACE_DIRECTORY.test(directory)) return true;
      return linkedWorktreeOf(directory, await listWorktrees(directory)) !== null;
    },
    isPageRenderingAvailable: toolSettingOn('agentRenderToolEnabled'),
    isSecretRequestAvailable: toolSettingOn('agentSecretToolEnabled'),
    isWorkflowAvailable: async () => isToolHost() && isWorkflowToolEnabled(),
    instructionEntries: {
      put: (sessionID, directory, key, value) => openCodeSessionClient(directory)
        .experimental.session.instructions.entry.put({ sessionID, key, value }),
      remove: (sessionID, directory, key) => openCodeSessionClient(directory)
        .experimental.session.instructions.entry.remove({ sessionID, key }),
    },
  });
};
