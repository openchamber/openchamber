/**
 * Reproduction test for issue #2137:
 * "Open subtask" inside a side-panel subagent chat does nothing on web/desktop (depth ≥ 2)
 *
 * The bug: When inside an embedded session chat iframe (ocPanel=session-chat),
 * clicking "Open subtask" on a nested (depth ≥ 2) subagent calls
 * `openContextPanelTab()` which modifies the UI store — but since the
 * embedded iframe renders no `<ContextPanel>`, the tab is never displayed.
 * The click is a silent no-op.
 *
 * VS Code and mobile are unaffected because they navigate in-place via
 * `setCurrentSession()` instead of `openContextPanelTab()`.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
  });
});

/**
 * Simulates the "Open subtask" handler from TaskToolSummary / UserSubtaskPart.
 *
 * Current behavior (buggy for embedded session chat):
 * - If mobile or VSCode → calls setCurrentSession (navigates in-place)
 * - Otherwise → calls openContextPanelTab (adds a tab to the store)
 *
 * Inside the embedded session chat iframe, the "otherwise" branch runs,
 * but no ContextPanel component is rendered so the tab is invisible.
 */
function simulateOpenSubtaskClick(params: {
  isMobile: boolean;
  isVSCode: boolean;
  sessionId: string;
  directory: string;
}) {
  const { isMobile, isVSCode, sessionId, directory } = params;

  // This is the branching logic from handleOpenSession (ToolPart.tsx:1374)
  // and UserSubtaskPart onClick (MessageBody.tsx:253)
  if (isMobile || isVSCode) {
    // setCurrentSession(sessionId, directory) — works correctly
    return { action: 'setCurrentSession' as const, sessionId, directory };
  }

  // openContextPanelTab(directory, { mode: 'chat', ... }) — silent no-op
  // when there's no ContextPanel to render the tab
  useUIStore.getState().openContextPanelTab(directory, {
    mode: 'chat',
    dedupeKey: `session:${sessionId}`,
    label: 'Subtask',
    readOnly: true,
  });
  return { action: 'openContextPanelTab' as const, sessionId, directory };
}

describe('Issue #2137: "Open subtask" inside embedded session chat (depth ≥ 2)', () => {
  test('Main chat (desktop web/electron): calls openContextPanelTab (creates tab in store)', () => {
    // In the main app window, this is the expected behavior:
    // a side-panel (ContextPanel) tab opens showing the subagent's chat.
    const result = simulateOpenSubtaskClick({
      isMobile: false,
      isVSCode: false,
      sessionId: 'ses_subtask_B',
      directory: '/repo',
    });

    expect(result.action).toBe('openContextPanelTab');

    // Verify the tab was added to the store
    const state = useUIStore.getState();
    const dirState = state.contextPanelByDirectory['/repo'];
    expect(dirState).toBeDefined();
    expect(dirState.tabs).toHaveLength(1);

    const tab = dirState.tabs[0];
    expect(tab!.mode).toBe('chat');
    expect(tab!.dedupeKey).toBe('session:ses_subtask_B');
    expect(tab!.readOnly).toBe(true);
  });

  test('Embedded session chat iframe (desktop, ocPanel=session-chat): calls openContextPanelTab but NO ContextPanel renders it', () => {
    // In the embedded session chat iframe, the same handler runs.
    // The App component renders EmbeddedSessionChatContent which only has
    // <ChatView /> — NO <ContextPanel />.
    //
    // So openContextPanelTab adds the tab to the store, but nothing renders it.
    // This is the root cause of bug #2137 — the click is a silent no-op.
    const result = simulateOpenSubtaskClick({
      isMobile: false,
      isVSCode: false,
      sessionId: 'ses_subtask_B',
      directory: '/repo',
    });

    expect(result.action).toBe('openContextPanelTab');

    // The tab IS in the store (proving the handler ran)...
    const state = useUIStore.getState();
    const dirState = state.contextPanelByDirectory['/repo'];
    expect(dirState).toBeDefined();
    expect(dirState.tabs).toHaveLength(1);

    // ...but the embedded iframe has no ContextPanel, so the user sees nothing.
    // The expected behavior would be to navigate in-place via setCurrentSession.
  });

  test('VS Code: calls setCurrentSession (works correctly)', () => {
    const result = simulateOpenSubtaskClick({
      isMobile: false,
      isVSCode: true,
      sessionId: 'ses_subtask_B',
      directory: '/repo',
    });

    expect(result.action).toBe('setCurrentSession');
    expect(result.sessionId).toBe('ses_subtask_B');
  });

  test('Mobile: calls setCurrentSession (works correctly)', () => {
    const result = simulateOpenSubtaskClick({
      isMobile: true,
      isVSCode: false,
      sessionId: 'ses_subtask_B',
      directory: '/repo',
    });

    expect(result.action).toBe('setCurrentSession');
    expect(result.sessionId).toBe('ses_subtask_B');
  });
});
