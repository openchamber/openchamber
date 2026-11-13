import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { switchRuntimeEndpoint } from './runtime-switch';
import { opencodeClient } from './opencode/client';
import type { Session } from './opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { ChildStoreManager } from '@/sync/child-store';
import { setActionRefs, setOptimisticRefs } from '@/sync/session-actions';

import { assertAutoReviewRuntimeStillCurrent, isAutoReviewRuntimeCurrent, sendReviewFeedbackToOriginal } from './reviewFlow';

describe('reviewFlow auto-review helpers', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
  });

  test('runtime guard rejects a start that began on another runtime', () => {
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(true);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(false);
    expect(() => assertAutoReviewRuntimeStillCurrent('runtime-a')).toThrow('runtime changed');
  });
});

describe('review feedback model pick settlement', () => {
  let manager: ChildStoreManager;
  const spies: Array<{ mockRestore: () => void }> = [];
  const original: Session = {
    id: 'original', projectID: 'project', directory: '/repo', title: 'Original',
    model: { providerID: 'p', id: 'picked' }, time: { created: 1, updated: 1 },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
    manager = new ChildStoreManager();
    manager.ensureChild('/repo', { bootstrap: false }).setState({ session: [original] });
    setActionRefs(manager, () => '/repo');
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true, currentAgentName: undefined });
    useSelectionStore.setState({ sessionPickedModels: new Map() });
    useSelectionStore.getState().saveSessionModelSelection('original', 'p', 'picked');
    useSelectionStore.getState().pickSessionModel('original', 'p', 'picked');
    spies.push(spyOn(opencodeClient, 'getSession').mockResolvedValue({
      ...original, id: 'review', metadata: { openchamber: { kind: 'review', originalSessionID: 'original' } },
    }));
    spies.push(spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ version: 1, overrides: {} })));
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    manager.disposeAll();
  });

  test('a failed review feedback send keeps its pick, then a successful send settles it', async () => {
    spies.push(spyOn(opencodeClient, 'sendMessage').mockRejectedValueOnce(new Error('send refused')).mockResolvedValue('msg'));
    await expect(sendReviewFeedbackToOriginal('review', '/repo', 'Feedback')).rejects.toThrow('send refused');
    expect(useSelectionStore.getState().getSessionModelPick('original')).toEqual({ providerId: 'p', modelId: 'picked' });
    await sendReviewFeedbackToOriginal('review', '/repo', 'Feedback');
    expect(useSelectionStore.getState().getSessionModelPick('original')).toBeNull();
  });

  test('a successful feedback send settles the captured runtime and leaves its replacement alone', async () => {
    spies.push(spyOn(opencodeClient, 'sendMessage').mockImplementation(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
      useSelectionStore.getState().pickSessionModel('original', 'p', 'picked');
      return 'msg';
    }));
    await sendReviewFeedbackToOriginal('review', '/repo', 'Feedback');
    expect(useSelectionStore.getState().getSessionModelPick('original')).toEqual({ providerId: 'p', modelId: 'picked' });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
    expect(useSelectionStore.getState().getSessionModelPick('original')).toBeNull();
  });
});
