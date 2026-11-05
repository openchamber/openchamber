import { describe, expect, test } from 'bun:test';

import { useGuestInstallRequestStore } from './install-request.ts';

describe('install request', () => {
  test('hands a request over once', () => {
    useGuestInstallRequestStore.setState({ request: { source: '/a', confirmed: true, isCurrent: () => true } });
    const { take } = useGuestInstallRequestStore.getState();
    expect(take()).toEqual({ source: '/a', confirmed: true });
    expect(take()).toBeNull();
  });

  test('drops a request made on another server', () => {
    useGuestInstallRequestStore.setState({ request: { source: '/a', confirmed: true, isCurrent: () => false } });
    expect(useGuestInstallRequestStore.getState().take()).toBeNull();
    expect(useGuestInstallRequestStore.getState().request).toBeNull();
  });
});
