/**
 * Helpers for MultiRun model selections that may target OpenCode or Claude Code.
 */

import type { ExecutionTarget } from '@/types/harness';
import { isClaudeEffort } from '@/types/harness';
import { CLAUDE_FAVORITE_PROVIDER_ID } from '@/lib/harness/favorite-targets';

export type MultiRunModelRef = {
  providerID: string;
  modelID: string;
  variant?: string;
};

export function isClaudeMultiRunModel(model: MultiRunModelRef): boolean {
  return model.providerID === CLAUDE_FAVORITE_PROVIDER_ID;
}

/**
 * Build the sticky ExecutionTarget for a MultiRun model chip.
 * Claude selections use `claude-code` + modelRef; OpenCode keeps provider/model.
 */
export function executionTargetFromMultiRunModel(
  model: MultiRunModelRef,
  options: { agent?: string } = {},
): ExecutionTarget {
  if (isClaudeMultiRunModel(model)) {
    const effort = model.variant && isClaudeEffort(model.variant) ? model.variant : undefined;
    return {
      harnessId: 'claude-code',
      modelRef: model.modelID,
      ...(effort ? { effort } : {}),
    };
  }
  return {
    harnessId: 'opencode',
    providerId: model.providerID,
    modelId: model.modelID,
    ...(options.agent ? { agentName: options.agent } : {}),
    ...(model.variant ? { variant: model.variant } : {}),
  };
}
