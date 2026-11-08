import { describe, expect, test } from 'bun:test';

import {
  guestMobileWorkspaceTabId,
  orderMobileWorkspaceTabs,
  sanitizeMobileWorkspaceTabOrder,
  shownMobileWorkspaceTabs,
  stripMobileWorkspaceTabs,
} from './mobileWorkspaceTabs';

describe('mobile workspace tabs', () => {
  test('a saved order keeps its tabs and places tabs it does not name where they go by default', () => {
    expect(orderMobileWorkspaceTabs(['terminal', 'gone', 'changes', 'terminal'])).toEqual(['status', 'files', 'terminal', 'changes', 'notes']);
    expect(orderMobileWorkspaceTabs([])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
  });

  test('an order saved before Status existed gets it first and loses the MCP tab', () => {
    expect(orderMobileWorkspaceTabs(['mcp', 'files', 'changes', 'terminal', 'notes'])).toEqual(['status', 'files', 'changes', 'terminal', 'notes']);
  });

  test('hidden tabs leave the strip, but never all of them', () => {
    expect(shownMobileWorkspaceTabs(['files'], ['changes', 'mcp'])).toEqual(['status', 'files', 'terminal', 'notes']);
    expect(shownMobileWorkspaceTabs([], ['status', 'changes', 'files', 'terminal', 'notes'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
  });

  test('a hidden tab something opened stays in the strip, in its place, while it is open', () => {
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'files')).toEqual(['status', 'changes', 'files', 'notes']);
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'notes')).toEqual(['status', 'changes', 'notes']);
  });

  test('extension panels are tabs after the built-ins, and keep a saved place', () => {
    const spark = guestMobileWorkspaceTabId('spark');
    expect(orderMobileWorkspaceTabs([], [spark])).toEqual(['status', 'changes', 'files', 'terminal', 'notes', spark]);
    expect(orderMobileWorkspaceTabs(['notes', spark, 'files'], [spark])).toEqual(['status', 'changes', 'terminal', 'notes', spark, 'files']);
  });

  test('an extension tab can be hidden, and the drawer still shows the built-ins', () => {
    const spark = guestMobileWorkspaceTabId('spark');
    expect(shownMobileWorkspaceTabs([], ['guest:spark'], [spark])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
    expect(stripMobileWorkspaceTabs([], ['guest:spark'], spark, [spark])).toEqual(['status', 'changes', 'files', 'terminal', 'notes', spark]);
    expect(shownMobileWorkspaceTabs([], ['status', 'changes', 'files', 'terminal', 'notes'], [spark])).toEqual([spark]);
  });

  test('the stored order keeps extension ids it does not currently show', () => {
    expect(sanitizeMobileWorkspaceTabOrder(['files', 'guest:spark', 'guest:spark', 'guest:Bad Id', 'mcp', 'notes']))
      .toEqual(['files', 'guest:spark', 'notes']);
    expect(orderMobileWorkspaceTabs(['files', 'guest:spark'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
  });
});
