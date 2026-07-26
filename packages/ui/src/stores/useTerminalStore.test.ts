import { afterEach, describe, expect, test } from 'bun:test';
import { useTerminalStore } from './useTerminalStore';

const setup = () => {
  useTerminalStore.getState().clearAll();
  useTerminalStore.getState().ensureDirectory('/repo');
  return useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].id;
};

describe('terminal state reconciliation', () => {
  afterEach(() => useTerminalStore.getState().clearAll());

  test('applies snapshots atomically and deduplicates output by sequence', () => {
    const tabId = setup();
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'prompt', 4);
    useTerminalStore.getState().appendToBuffer('/repo', tabId, ' output', 5);
    useTerminalStore.getState().appendToBuffer('/repo', tabId, ' duplicate', 5);
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0];
    expect(tab.bufferChunks.map((chunk) => chunk.data).join('')).toBe('prompt output');
    expect(tab.lastSequence).toBe(5);
  });

  test('keeps raw live bytes separate from replay-safe bytes', () => {
    const tabId = setup();
    useTerminalStore.getState().appendToBuffer('/repo', tabId, 'prompt\u001b[6n', 1, 'prompt');
    const chunk = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].bufferChunks[0];
    expect(chunk.data).toBe('prompt\u001b[6n');
    expect(chunk.replayData).toBe('prompt');
  });

  test('uses collision-resistant tab identities', () => {
    const tabId = setup();
    expect(/^tab-\d+$/.test(tabId)).toBe(false);
  });

  test('does not let stale snapshots replace newer output', () => {
    const tabId = setup();
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'new', 8);
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'stale', 7);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].bufferChunks[0].data).toBe('new');
  });

  test('preserves buffer identity for an identical snapshot', () => {
    const tabId = setup();
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'prompt', 8);
    const previous = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].bufferChunks;
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'prompt', 8);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].bufferChunks).toBe(previous);
  });

  test('caps multibyte scrollback by UTF-8 bytes', () => {
    const tabId = setup();
    useTerminalStore.getState().appendToBuffer('/repo', tabId, '界'.repeat(200_000), 1);
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0];
    expect(tab.bufferLength <= 512 * 1024).toBe(true);
    expect(new TextEncoder().encode(tab.bufferChunks[0].data).byteLength).toBe(tab.bufferLength);
  });
});
