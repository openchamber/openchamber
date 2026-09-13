import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { switchRuntimeEndpoint } from './runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { setActionRefs, setOptimisticRefs } from '@/sync/session-actions';
import { ChildStoreManager } from '@/sync/child-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore, type AgentWithExtras } from '@/stores/useAgentsStore';
import { useSelectionStore } from '@/sync/selection-store';

import {
  assertAutoReviewRuntimeStillCurrent,
  claimAutoReviewForward,
  releaseAutoReviewForward,
  hasFinalReviewMarker,
  isAutoReviewRuntimeCurrent,
  isExpectedAutoReviewAssistantParent,
  sendPlainMessage,
  stripFinalReviewMarker,
} from './reviewFlow';
import type { AutoReviewRun } from '@/stores/useAutoReviewStore';

describe('reviewFlow auto-review helpers', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
  });

  test('detects and strips final review marker only from the final line', () => {
    const text = 'No remaining issues.\n\nFINAL_REVIEW_STATUS: no_remaining_findings\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No remaining issues.');
  });

  test('detects and strips final review marker case-insensitively', () => {
    const text = 'No findings.\nFINAL_REVIEW_STATUS: no_remaining_findINGS\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No findings.');
  });

  test('does not treat quoted or non-final marker text as completion', () => {
    const text = 'The marker is FINAL_REVIEW_STATUS: no_remaining_findings, but issues remain.';

    expect(hasFinalReviewMarker(text)).toBe(false);
    expect(stripFinalReviewMarker(text)).toBe(text);
  });

  test('requires assistant parent to match the auto-sent user message when provided', () => {
    const matching = { id: 'msg_assistant_1', parentID: 'msg_user_auto' } as Message;
    const unrelated = { id: 'msg_assistant_2', parentID: 'msg_user_manual' } as Message;

    expect(isExpectedAutoReviewAssistantParent(matching, 'msg_user_auto')).toBe(true);
    expect(isExpectedAutoReviewAssistantParent(unrelated, 'msg_user_auto')).toBe(false);
    expect(isExpectedAutoReviewAssistantParent(unrelated)).toBe(true);
  });

  test('runtime guard rejects runs from a stale runtime', () => {
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(true);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(false);
    expect(() => assertAutoReviewRuntimeStillCurrent('runtime-a')).toThrow('runtime changed');
  });

  test('claims only one in-flight forward for the same auto-review message', () => {
    const run: AutoReviewRun = {
      originalSessionID: 'original-1',
      reviewSessionID: 'review-1',
      directory: '/workspace',
      runtimeKey: 'runtime-a',
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 0,
      maxIterations: 15,
      expectedAssistantParentID: 'msg_user_prompt',
    };

    const key = claimAutoReviewForward(run, 'msg_assistant_review');

    expect(typeof key).toBe('string');
    expect(claimAutoReviewForward(run, 'msg_assistant_review')).toBeNull();

    releaseAutoReviewForward(key!);
    const nextKey = claimAutoReviewForward(run, 'msg_assistant_review');
    expect(nextKey).toBe(key);
    releaseAutoReviewForward(nextKey!);
  });
});

describe('sendPlainMessage agent availability guard', () => {
  const SESSION = 'session-review-guard';
  const DIRECTORY = '/projects/review-guard';
  const PROVIDER = 'provider-a';
  const MODEL = 'model-a';

  const agent = (name: string): AgentWithExtras => ({
    name,
    mode: 'subagent',
    permission: [],
    options: {},
  });

  const sentMessages: Array<Parameters<typeof opencodeClient.sendMessage>[0]> = [];
  const originalSendMessage = opencodeClient.sendMessage;
  const originalIsConnected = useConfigStore.getState().isConnected;
  const sdk = createOpencodeClient({
    baseUrl: 'http://review-flow.test',
    fetch: async () => Response.json({}),
  });
  let childStores: ChildStoreManager;

  beforeEach(() => {
    sentMessages.length = 0;
    useAgentsStore.setState({ agentsByDirectory: {} });
    useSelectionStore.getState().clearSessionSelections(SESSION);
    childStores = new ChildStoreManager();
    setActionRefs(sdk, childStores, () => DIRECTORY);
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true });
    opencodeClient.sendMessage = async (params) => {
      sentMessages.push(params);
      return 'msg';
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
    useConfigStore.setState({ isConnected: originalIsConnected });
    childStores.disposeAll();
    useSelectionStore.getState().clearSessionSelections(SESSION);
  });

  const send = (agentName: string) => sendPlainMessage(SESSION, DIRECTORY, 'review text', {
    providerID: PROVIDER,
    modelID: MODEL,
    agent: agentName,
  });

  test('drops a missing agent, does not persist it, and still sends', async () => {
    useAgentsStore.setState({
      agentsByDirectory: { [DIRECTORY]: [agent('build')] },
    });

    const sentMessageID = await send('ghost');

    expect(sentMessageID).toBeTruthy();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.agent).toBeUndefined();
    expect(sentMessages[0]?.providerID).toBe(PROVIDER);
    // The unavailable name must not become this session's persisted choice.
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBeNull();
    expect(useSelectionStore.getState().getAgentModelForSession(SESSION, 'ghost')).toBeNull();
  });

  test('keeps an available agent and persists its selection', async () => {
    useAgentsStore.setState({
      agentsByDirectory: { [DIRECTORY]: [agent('build')] },
    });

    const sentMessageID = await send('build');

    expect(sentMessageID).toBeTruthy();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.agent).toBe('build');
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBe('build');
    expect(useSelectionStore.getState().getAgentModelForSession(SESSION, 'build')).toEqual({
      providerId: PROVIDER,
      modelId: MODEL,
    });
  });

  test('fails open while the directory list has not loaded', async () => {
    useAgentsStore.setState({ agentsByDirectory: {} });

    const sentMessageID = await send('ghost');

    expect(sentMessageID).toBeTruthy();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.agent).toBe('ghost');
    expect(useSelectionStore.getState().getSessionAgentSelection(SESSION)).toBe('ghost');
  });
});
