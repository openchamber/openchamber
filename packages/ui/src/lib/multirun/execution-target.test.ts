import { describe, expect, it } from 'bun:test';
import {
  executionTargetFromMultiRunModel,
  isClaudeMultiRunModel,
} from './execution-target';

describe('executionTargetFromMultiRunModel', () => {
  it('maps Claude MultiRun chips to claude-code ExecutionTargets', () => {
    expect(isClaudeMultiRunModel({ providerID: 'claude-code', modelID: 'haiku' })).toBe(true);
    expect(executionTargetFromMultiRunModel({
      providerID: 'claude-code',
      modelID: 'haiku',
      variant: 'high',
    })).toEqual({
      harnessId: 'claude-code',
      modelRef: 'haiku',
      effort: 'high',
    });
  });

  it('maps OpenCode chips to opencode ExecutionTargets', () => {
    expect(executionTargetFromMultiRunModel({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-5',
      variant: 'high',
    }, { agent: 'build' })).toEqual({
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      agentName: 'build',
      variant: 'high',
    });
  });
});
