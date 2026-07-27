/**
 * Resolve Claude Code send options from the selected agents mode.
 *
 * - `opencode`: inherit OpenChamber/OpenCode agent edit permission + prompt
 * - `claude`: use native Claude Code prompts/permissions (no OpenCode inheritance)
 */

import type { ClaudePermissionMode, ExecutionTarget } from '@/types/harness';
import type { ClaudeAgentsMode } from '@/lib/harness/settings';
import { claudePermissionModeFromEditPermission } from '@/lib/harness/claude-models';
import {
  getAgentDefaultEditPermission,
  getAgentPrompt,
} from '@/stores/utils/permissionUtils';

export type ClaudeAgentsSendOptions = {
  /** Target with permissionMode set only in OpenCode agents mode. */
  target: Extract<ExecutionTarget, { harnessId: 'claude-code' }>;
  /** OpenCode agent prompt to append to Claude's system prompt (opencode mode only). */
  systemPromptAppend?: string;
  agentsMode: ClaudeAgentsMode;
};

/**
 * Apply agents-mode policy to a Claude execution target for one send.
 */
export function resolveClaudeAgentsSendOptions(params: {
  target: Extract<ExecutionTarget, { harnessId: 'claude-code' }>;
  agentsMode: ClaudeAgentsMode;
  agentName?: string;
}): ClaudeAgentsSendOptions {
  const agentsMode = params.agentsMode;
  const base: Extract<ExecutionTarget, { harnessId: 'claude-code' }> = {
    harnessId: 'claude-code',
    modelRef: params.target.modelRef,
    ...(params.target.effort ? { effort: params.target.effort } : {}),
  };

  if (agentsMode === 'claude') {
    // Native Claude: do not inherit OpenCode permissionMode or agent prompts.
    return { target: base, agentsMode };
  }

  const permissionMode: ClaudePermissionMode = claudePermissionModeFromEditPermission(
    getAgentDefaultEditPermission(params.agentName),
  );
  const prompt = getAgentPrompt(params.agentName);
  return {
    agentsMode,
    target: {
      ...base,
      permissionMode,
    },
    ...(prompt ? { systemPromptAppend: prompt } : {}),
  };
}
