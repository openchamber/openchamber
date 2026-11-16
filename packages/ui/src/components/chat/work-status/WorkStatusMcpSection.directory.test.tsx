import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { toast } from 'sonner';
import { opencodeClient } from '@/lib/opencode/client';
import type { McpServerStatus } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { setupMcpDirectoryHarness } from '@/components/mcp/mcpDirectory.fixture';
import { WorkStatusMcpSection } from './WorkStatusMcpSection';

const servers = (connected: boolean): McpServerStatus[] => [{
  name: 'fixture', status: connected ? { status: 'connected' } : { status: 'disabled' },
}];

describe('WorkStatusMcpSection', () => {
  const { harness, renderNode, openChatDraft, prepareFixture } = setupMcpDirectoryHarness();
  const initialExpanded = useUIStore.getState().workStatusExpandedSections;
  beforeEach(() => {
    useUIStore.setState({ workStatusExpandedSections: { ...initialExpanded, mcp: true } });
  });
  afterEach(() => {
    useUIStore.setState({ workStatusExpandedSections: initialExpanded });
  });

  test('a Chat draft reads and toggles only its prepared directory', async () => {
    openChatDraft();
    prepareFixture();
    const connected = new Map<string | null | undefined, boolean>([['C:/proj-a', true]]);
    harness.listServers = async (directory) => servers(connected.get(directory) ?? false);
    const connect = spyOn(opencodeClient, 'connectMcpServer').mockImplementation(async (_name, directory) => {
      connected.set(directory, true);
    });
    harness.extraSpies.push(connect);

    const host = await renderNode(<WorkStatusMcpSection sessionId={null} directory={null} />);
    const prepared = useSessionUIStore.getState().newSessionDraft.preparedChatDirectory;
    expect(prepared?.startsWith('/chats/')).toBe(true);
    expect(harness.listSpy.mock.calls).toEqual([[prepared]]);
    const toggle = host.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle?.click());
    expect(connect.mock.calls[0]).toEqual(['fixture', prepared]);
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(connected.get('C:/proj-a')).toBe(true);
  });

  test('a failed Chat preparation never reads the previous Chat', async () => {
    openChatDraft();
    const create = prepareFixture();
    create.mockRejectedValue(new Error('Cannot create Chat directory'));
    harness.extraSpies.push(spyOn(toast, 'error').mockImplementation(() => 'toast'));
    harness.listServers = async () => servers(true);
    const host = await renderNode(<WorkStatusMcpSection sessionId={null} directory={null} />);
    expect(harness.listSpy.mock.calls.length).toBe(0);
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });

  test('a pinned session reads its own directory while the main Chat is a draft', async () => {
    openChatDraft();
    const create = prepareFixture();
    await renderNode(<WorkStatusMcpSection sessionId="pinned-chat" directory="/chats/pinned" />);
    expect(create.mock.calls.length).toBe(0);
    expect(harness.listSpy.mock.calls).toEqual([['/chats/pinned']]);
  });

  test('a rejected toggle shows the error and leaves the switch usable', async () => {
    harness.listServers = async () => servers(false);
    const connect = spyOn(opencodeClient, 'connectMcpServer').mockRejectedValue(new Error('Server refused to start'));
    const error = spyOn(toast, 'error').mockImplementation(() => 'toast');
    harness.extraSpies.push(connect, error);

    const host = await renderNode(<WorkStatusMcpSection sessionId="session" directory="/repo" />);
    const toggle = () => host.querySelector<HTMLElement>('[role="switch"]');
    await act(async () => toggle()?.click());

    expect(connect.mock.calls.length).toBe(1);
    expect(error.mock.calls[0]?.[0]).toBe('Server refused to start');
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(toggle()?.hasAttribute('disabled')).toBe(false);

    await act(async () => toggle()?.click());
    expect(connect.mock.calls.length).toBe(2);
  });
});
