import { afterEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';

import { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';

const initialBrowserEnabled = useUIStore.getState().serverBrowserEnabled;
const initialDebugPort = useUIStore.getState().serverBrowserDebugPort;
afterEach(() => { useUIStore.setState({ serverBrowserEnabled: initialBrowserEnabled, serverBrowserDebugPort: initialDebugPort }); });

describe('runtime browser availability', () => {
  test('clears the previous server setting before destination settings load', () => {
    useUIStore.setState({ serverBrowserEnabled: true, serverBrowserDebugPort: 9222 });

    resetAppForRuntimeEndpointChange({
      previousApiBaseUrl: 'https://previous.example',
      apiBaseUrl: 'https://next.example',
      previousRuntimeKey: 'server-previous',
      runtimeKey: 'server-next',
    });

    expect(useUIStore.getState().serverBrowserEnabled).toBe(false);
    expect(useUIStore.getState().serverBrowserDebugPort).toBe(0);
  });

  test('preserves the server setting during a transport change on the same device', () => {
    useUIStore.setState({ serverBrowserEnabled: true, serverBrowserDebugPort: 9222 });

    reconnectAppForTransportSwitch();

    expect(useUIStore.getState().serverBrowserEnabled).toBe(true);
    expect(useUIStore.getState().serverBrowserDebugPort).toBe(9222);
  });
});
