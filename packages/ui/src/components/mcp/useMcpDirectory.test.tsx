import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { toast } from 'sonner';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useMcpDirectory } from './useMcpDirectory';
import { setupMcpDirectoryHarness } from './mcpDirectory.fixture';

const Probe: React.FC<{ active: boolean; selection?: { sessionId: string | null; directory: string | null } }> = ({ active, selection }) => {
  const directory = useMcpDirectory(active, selection);
  return <output data-directory={directory ?? ''} />;
};

const readDirectory = (host: HTMLElement) => host.querySelector('output')?.getAttribute('data-directory') || null;

describe('useMcpDirectory', () => {
  const { harness, renderNode, openChatDraft, openProjectDraft, prepareFixture } = setupMcpDirectoryHarness();

  test('an inactive Chat draft prepares nothing and never falls back to the previous Chat', async () => {
    openChatDraft();
    const create = prepareFixture();
    const host = await renderNode(<Probe active={false} />);
    expect(create.mock.calls.length).toBe(0);
    expect(readDirectory(host)).toBeNull();
  });

  test('an active Chat draft resolves to the directory first send reuses', async () => {
    openChatDraft();
    const create = prepareFixture();
    const host = await renderNode(<Probe active />);
    const prepared = useSessionUIStore.getState().newSessionDraft.preparedChatDirectory;
    expect(prepared?.startsWith('/chats/')).toBe(true);
    expect(readDirectory(host)).toBe(prepared);
    expect(await useSessionUIStore.getState().prepareChatDraftDirectory()).toBe(prepared);
    expect(create.mock.calls.length).toBe(1);
  });

  test('preparation failure reports the error and leaves no directory', async () => {
    openChatDraft();
    const create = prepareFixture();
    create.mockRejectedValue(new Error('Cannot create Chat directory'));
    const error = spyOn(toast, 'error').mockImplementation(() => 'toast');
    harness.extraSpies.push(error);
    const host = await renderNode(<Probe active />);
    expect(readDirectory(host)).toBeNull();
    expect(error.mock.calls[0]?.[0]).toBe('Cannot create Chat directory');
  });

  test('changing drafts during preparation discards the old directory', async () => {
    openChatDraft(100);
    const create = prepareFixture();
    let finish = (_value: { success: boolean; path: string }) => {};
    const pending = new Promise<{ success: boolean; path: string }>((resolve) => { finish = resolve; });
    create.mockImplementationOnce(() => pending);
    const cleanup = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    harness.extraSpies.push(cleanup);
    const host = await renderNode(<Probe active />);
    expect(create.mock.calls.length).toBe(1);
    expect(readDirectory(host)).toBeNull();
    const oldPath = create.mock.calls[0][0];
    await act(async () => { openChatDraft(101); });
    const currentPath = useSessionUIStore.getState().newSessionDraft.preparedChatDirectory;
    expect(currentPath).not.toBe(oldPath);
    await act(async () => { finish({ success: true, path: oldPath }); });
    expect(useSessionUIStore.getState().newSessionDraft.preparedChatDirectory).toBe(currentPath);
    expect(readDirectory(host)).toBe(currentPath);
    expect(cleanup.mock.calls.length).toBe(1);
  });

  test('a pinned session keeps its own directory while the main Chat is a draft', async () => {
    openChatDraft();
    const create = prepareFixture();
    const host = await renderNode(<Probe active selection={{ sessionId: 'pinned-chat', directory: '/chats/pinned' }} />);
    expect(create.mock.calls.length).toBe(0);
    expect(readDirectory(host)).toBe('/chats/pinned');
  });

  test('a project draft resolves to its selected directory', async () => {
    openProjectDraft('/project-b');
    const host = await renderNode(<Probe active />);
    expect(readDirectory(host)).toBe('/project-b');
  });
});
