import { describe, expect, test } from 'bun:test';

import { orderMobileWorkspaceTabs, shownMobileWorkspaceTabs, storedMobileWorkspaceTabOrder, stripMobileWorkspaceTabs } from './mobileWorkspaceTabs';

describe('mobile workspace tabs', () => {
  test('a saved order keeps its tabs and places tabs it does not name where they go by default', () => {
    expect(orderMobileWorkspaceTabs(['terminal', 'gone', 'changes', 'terminal'])).toEqual(['status', 'files', 'terminal', 'changes', 'preview', 'notes']);
    expect(orderMobileWorkspaceTabs([])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
  });

  test('an order saved before Status existed gets it first and loses the MCP tab', () => {
    expect(orderMobileWorkspaceTabs(['mcp', 'files', 'changes', 'terminal', 'notes'])).toEqual(['status', 'files', 'changes', 'terminal', 'preview', 'notes']);
  });

  test('hidden tabs leave the strip, but never all of them', () => {
    expect(shownMobileWorkspaceTabs(['files'], ['changes', 'mcp'])).toEqual(['status', 'files', 'terminal', 'preview', 'notes']);
    expect(shownMobileWorkspaceTabs([], ['status', 'changes', 'files', 'terminal', 'preview', 'notes'])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
  });

  test('a hidden tab something opened stays in the strip, in its place, while it is open', () => {
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'files')).toEqual(['status', 'changes', 'files', 'preview', 'notes']);
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'notes')).toEqual(['status', 'changes', 'preview', 'notes']);
  });

  test('a new extension tab goes last; a saved one keeps its place; one not available now is left out', () => {
    expect(orderMobileWorkspaceTabs([], ['plugin:tasks'])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes', 'plugin:tasks']);
    const saved = ['plugin:tasks', 'status', 'changes', 'plugin:gone', 'files', 'terminal', 'notes'];
    expect(orderMobileWorkspaceTabs(saved, ['plugin:tasks', 'plugin:config'])).toEqual(['plugin:tasks', 'status', 'changes', 'files', 'terminal', 'preview', 'notes', 'plugin:config']);
    expect(orderMobileWorkspaceTabs(saved)).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
    expect(shownMobileWorkspaceTabs(saved, ['plugin:tasks'], ['plugin:tasks'])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
  });

  test('a stored order keeps the saved place of an extension that is not available now', () => {
    const previous = ['status', 'plugin:gone', 'changes', 'files', 'terminal', 'notes', 'plugin:tasks'];
    expect(storedMobileWorkspaceTabOrder(['plugin:tasks', 'status', 'changes', 'files', 'terminal', 'notes'], previous))
      .toEqual(['plugin:tasks', 'status', 'plugin:gone', 'changes', 'files', 'terminal', 'preview', 'notes']);
    // Unavailable tabs that led the saved order stay first, in their saved order.
    expect(storedMobileWorkspaceTabOrder(['notes', 'status', 'changes', 'files', 'terminal'], ['plugin:a', 'plugin:b', 'status', 'changes', 'files', 'terminal', 'notes']))
      .toEqual(['plugin:a', 'plugin:b', 'preview', 'notes', 'status', 'changes', 'files', 'terminal']);
    expect(storedMobileWorkspaceTabOrder(['notes', 'unknown', 'files'], [])).toEqual(['status', 'changes', 'terminal', 'preview', 'notes', 'files']);
  });
});
