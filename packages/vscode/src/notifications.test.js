import { beforeEach, describe, expect, mock, test } from 'bun:test';

const showInformationMessage = mock(async () => undefined);
const showWarningMessage = mock(async () => undefined);
const showErrorMessage = mock(async () => undefined);
const executeCommand = mock(async () => undefined);
let windowFocused = false;

mock.module('vscode', () => ({
  window: {
    get state() {
      return { focused: windowFocused };
    },
    showInformationMessage,
    showWarningMessage,
    showErrorMessage,
  },
  commands: { executeCommand },
}));

const { showVSCodeNotification, __testOnly } = await import('./notifications.ts');
const { handleNotificationsBridgeMessage } = await import('./bridge-notifications-runtime.ts');

describe('extension-host notifications (replaces webview Notification API)', () => {
  beforeEach(() => {
    showInformationMessage.mockClear();
    showWarningMessage.mockClear();
    showErrorMessage.mockClear();
    executeCommand.mockClear();
    windowFocused = false;
    __testOnly.resetClaims();
  });

  test('completion shows via showInformationMessage and reports shown', async () => {
    const shown = await showVSCodeNotification({ title: 'Agent is ready', body: 'done', sessionId: 's1', kind: 'completion' });
    expect(shown).toBe(true);
    expect(showInformationMessage).toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalledWith('openchamber.openSidebar');
  });

  test('error and question route to their own surfaces', async () => {
    await showVSCodeNotification({ title: 'Tool error', kind: 'error' });
    expect(showErrorMessage).toHaveBeenCalled();
    await showVSCodeNotification({ title: 'Input needed', kind: 'question' });
    expect(showWarningMessage).toHaveBeenCalled();
  });

  test('requireHidden is suppressed when the window is focused, without showing', async () => {
    windowFocused = true;
    const shown = await showVSCodeNotification({ title: 't', requireHidden: true });
    expect(shown).toBe(true);
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  test('duplicate payloads within the claim window only show once', async () => {
    const payload = { title: 'Agent is ready', body: 'done', sessionId: 's1', kind: 'completion' };
    await showVSCodeNotification(payload);
    const second = await showVSCodeNotification(payload);
    expect(second).toBe(true);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });

  test('host failure reports false so the Settings test button is honest', async () => {
    showInformationMessage.mockRejectedValueOnce(new Error('boom'));
    const shown = await showVSCodeNotification({ title: 't' });
    expect(shown).toBe(false);
  });

  test('bridge api:notifications:show returns the host outcome', async () => {
    const response = await handleNotificationsBridgeMessage({
      id: 'n1',
      type: 'api:notifications:show',
      payload: { title: 'Ready', kind: 'test' },
    });
    expect(response).toEqual({ id: 'n1', type: 'api:notifications:show', success: true, data: { shown: true } });
    expect(showInformationMessage).toHaveBeenCalled();
  });

  test('bridge ignores unknown types', async () => {
    const response = await handleNotificationsBridgeMessage({ id: 'x', type: 'api:other', payload: {} });
    expect(response).toBeNull();
  });
});
