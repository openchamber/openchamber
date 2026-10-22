import { describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { ChildStoreManager, markDirectorySessionPartChanged } from './child-store';
import { setSyncRefs, subscribeToSyncSessionWork } from './sync-refs';
import { createEventRoutingIndex, handleEvent } from './sync-context';
import { currentSubagentWaits } from './current-session-work';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { SyncEvent } from '@/lib/opencode/events';

describe('imperative current-work subscriptions', () => {
  test('binds to late stores and owners without creating or bootstrapping directories', () => {
    const first = new ChildStoreManager();
    const second = new ChildStoreManager();
    setSyncRefs(opencodeClient.getSdkClient(), first, '/work');
    let notifications = 0;
    const unsubscribe = subscribeToSyncSessionWork(new Map([['root', '/work']]), () => { notifications += 1; });
    try {
      expect(first.children.size).toBe(0);
      const oldStore = first.ensureChild('/work', { bootstrap: false });
      const count = notifications;
      oldStore.setState({ message: { root: [] } });
      expect(notifications).toBe(count + 1);
      setSyncRefs(opencodeClient.getSdkClient(), second, '/work');
      const afterSwitch = notifications;
      oldStore.setState({ message: { root: [] } });
      expect(notifications).toBe(afterSwitch);
      expect(second.children.size).toBe(0);
      const newStore = second.ensureChild('/work', { bootstrap: false });
      const beforeNew = notifications;
      newStore.setState({ message: { root: [] } });
      expect(notifications).toBe(beforeNew + 1);
      unsubscribe();
      newStore.setState({ message: { root: [] } });
      expect(notifications).toBe(beforeNew + 1);
    } finally {
      unsubscribe();
      first.disposeAll();
      second.disposeAll();
    }
  });

  test('ignores 1000 token-only changes but reports tool, snapshot and message changes', () => {
    const manager = new ChildStoreManager();
    const store = manager.ensureChild('/work', { bootstrap: false });
    setSyncRefs(opencodeClient.getSdkClient(), manager, '/work');
    let notifications = 0;
    const unsubscribe = subscribeToSyncSessionWork(new Map([['root', '/work']]), () => { notifications += 1; });
    try {
      for (let i = 0; i < 1000; i += 1) {
        markDirectorySessionPartChanged(store, 'root', 'step', false);
        store.setState({ part: { step: [] } });
      }
      expect(notifications).toBe(0);
      markDirectorySessionPartChanged(store, 'unrelated', 'other');
      store.setState({ part: { step: [], other: [] } });
      expect(notifications).toBe(0);
      markDirectorySessionPartChanged(store, 'root', 'step');
      store.setState({ part: { step: [] } });
      expect(notifications).toBe(1);
      store.setState({ part: { step: [] } });
      expect(notifications).toBe(2);
      store.setState({ message: { root: [] } });
      expect(notifications).toBe(3);
    } finally {
      unsubscribe();
      manager.disposeAll();
    }
  });

  test('the real event reducer separates token deltas from foreground dependency changes', () => {
    const manager = new ChildStoreManager();
    const store = manager.ensureChild('/work', { bootstrap: false });
    store.setState({
      message: { root: [{ id: 'step', sessionID: 'root', role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm', time: { created: 1 } }] },
      part: { step: [{ id: 'text', sessionID: 'root', messageID: 'step', type: 'text', text: '', time: { start: 1 } }] },
    });
    setSyncRefs(opencodeClient.getSdkClient(), manager, '/work');
    let notifications = 0;
    const unsubscribe = subscribeToSyncSessionWork(new Map([['root', '/work']]), () => { notifications += 1; });
    const routing = createEventRoutingIndex();
    const send = (event: SyncEvent) => handleEvent('/work', event, manager, routing, getRuntimeKey());
    try {
      for (let i = 0; i < 1000; i += 1) send({ type: 'message.part.delta', properties: { sessionID: 'root', messageID: 'step', partID: 'text', field: 'text', delta: 'x' } });
      const streamed = store.getState().part.step[0];
      expect(streamed.type).toBe('text');
      if (streamed.type === 'text') expect(streamed.text).toHaveLength(1000);
      expect(notifications).toBe(0);
      send({ type: 'message.part.updated', properties: { sessionID: 'root', part: { id: 'text', sessionID: 'root', messageID: 'step', type: 'text', text: 'Done', time: { start: 1, end: 2 } } } });
      send({ type: 'message.patched', properties: { sessionID: 'root', messageID: 'step', patch: { time: { streamed: 2 } } } });
      send({ type: 'message.part.updated', properties: { sessionID: 'root', part: { id: 'call', callID: 'call', sessionID: 'root', messageID: 'step', type: 'tool', tool: 'subagent', state: { status: 'running', input: {}, time: { start: 2 } } } } });
      expect(currentSubagentWaits(store.getState(), 'root')).toEqual([]);
      send({ type: 'message.tool.transition', properties: { sessionID: 'root', messageID: 'step', partID: 'call', transition: { kind: 'progress', metadata: { sessionID: 'child' } } } });
      expect(currentSubagentWaits(store.getState(), 'root')).toEqual(['child']);
      expect(notifications).toBe(4);
      send({ type: 'message.tool.transition', properties: { sessionID: 'root', messageID: 'step', partID: 'call', transition: { kind: 'success', output: '', metadata: { sessionID: 'child', status: 'running' }, executed: true, end: 3 } } });
      expect(currentSubagentWaits(store.getState(), 'root')).toEqual([]);
      expect(notifications).toBe(5);
    } finally {
      unsubscribe();
      manager.disposeAll();
    }
  });
});
