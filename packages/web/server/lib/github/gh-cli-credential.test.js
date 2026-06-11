import { beforeEach, describe, expect, mock, test } from 'bun:test';

const execFileSyncMock = mock(() => '');

mock.module('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const { clearGhCliTokenCache, getGhCliToken } = await import('./gh-cli-credential.js');

describe('gh CLI credential lookup', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    clearGhCliTokenCache();
  });

  test('hides the subprocess window on Windows', () => {
    execFileSyncMock.mockReturnValueOnce('token\n');

    expect(getGhCliToken()).toBe('token');
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    });
  });

  test('caches unavailable gh CLI result until cache is cleared', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('gh unavailable');
    });

    expect(getGhCliToken()).toBeNull();
    expect(getGhCliToken()).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    clearGhCliTokenCache();

    expect(getGhCliToken()).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
