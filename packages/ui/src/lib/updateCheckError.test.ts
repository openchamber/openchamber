import { describe, expect, test } from 'bun:test';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { getUpdateCheckErrorMessage } from './updateCheckError';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

const ipc = (cause: string) => new Error(`Error invoking remote method 'openchamber:invoke': Error: Unable to check for updates (${cause})`);

describe('getUpdateCheckErrorMessage', () => {
  test('a server error from GitHub says so instead of blaming the network', () => {
    expect(getUpdateCheckErrorMessage(ipc('HTTP 504'))).toBe(t('updateDialog.error.checkServerError', { status: '504' }));
  });

  test('a network code asks to check the connection', () => {
    expect(getUpdateCheckErrorMessage(ipc('ENOTFOUND'))).toBe(t('updateDialog.error.checkOffline'));
    expect(getUpdateCheckErrorMessage(ipc('ERR_INTERNET_DISCONNECTED'))).toBe(t('updateDialog.error.checkOffline'));
  });

  test('any other cause is named as is', () => {
    expect(getUpdateCheckErrorMessage(ipc('HTTP 403'))).toBe(t('updateDialog.error.checkFailed', { detail: 'HTTP 403' }));
    expect(getUpdateCheckErrorMessage(ipc('Cannot parse feed'))).toBe(t('updateDialog.error.checkFailed', { detail: 'Cannot parse feed' }));
  });

  test('other errors keep their text without the IPC prefix', () => {
    expect(getUpdateCheckErrorMessage(new Error("Error invoking remote method 'openchamber:invoke': Error: Desktop update only works on Local instance")))
      .toBe('Desktop update only works on Local instance');
  });
});
