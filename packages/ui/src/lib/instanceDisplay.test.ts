import { describe, expect, test } from 'bun:test';
import { resolveDesktopInstanceDisplay } from './instanceDisplay';

describe('resolveDesktopInstanceDisplay', () => {
  test('identifies packaged Electron local runtime when the initial local origin is missing', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: true,
      runtimeKey: 'url:http://127.0.0.1:43123',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: '',
      hosts: [],
    })).toEqual({ kind: 'local' });
  });

  test('identifies Local when the runtime API matches the authoritative local origin', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: false,
      runtimeKey: 'url:http://127.0.0.1:43123',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: 'http://127.0.0.1:43123',
      hosts: [],
    })).toEqual({ kind: 'local' });
  });

  test('does not infer Local from loopback alone outside packaged Electron', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: false,
      runtimeKey: 'url:http://127.0.0.1:43123',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: '',
      hosts: [],
    })).toEqual({ kind: 'generic' });
  });

  test('prefers a host-specific runtime key over the packaged local fallback', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: true,
      runtimeKey: 'host:ssh-workstation',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: '',
      hosts: [{ id: 'ssh-workstation', label: 'Workstation', url: 'ssh://workstation', apiUrl: 'http://127.0.0.1:43123' }],
    })).toEqual({ kind: 'host', label: 'Workstation' });
  });

  test('prefers a configured loopback host label over the packaged local fallback', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: true,
      runtimeKey: 'url:http://127.0.0.1:43123',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: '',
      hosts: [{ id: 'ssh-workstation', label: 'Workstation', url: 'ssh://workstation', apiUrl: 'http://127.0.0.1:43123' }],
    })).toEqual({ kind: 'host', label: 'Workstation' });
  });

  test('keeps configured direct remote URLs labeled with their host', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: true,
      runtimeKey: 'host:remote',
      runtimeApiBaseUrl: 'https://remote.example',
      localOrigin: '',
      hosts: [{ id: 'remote', label: 'Remote', url: 'https://remote.example' }],
    })).toEqual({ kind: 'host', label: 'Remote' });
  });

  test('keeps relay host identity even when its virtual API base is loopback', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: true,
      runtimeKey: 'host:relay-home',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: '',
      hosts: [{ id: 'relay-home', label: 'Home Relay', url: 'relay://server-id' }],
    })).toEqual({ kind: 'host', label: 'Home Relay' });
  });

  test('does not infer Local for an unconfigured direct-E2EE loopback runtime', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: true,
      runtimeKey: 'http://127.0.0.1:43123',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: '',
      hosts: [],
    })).toEqual({ kind: 'generic' });
  });

  test('does not infer Local for an unknown host-specific runtime key', () => {
    expect(resolveDesktopInstanceDisplay({
      isPackagedElectronPage: true,
      runtimeKey: 'host:missing',
      runtimeApiBaseUrl: 'http://127.0.0.1:43123',
      localOrigin: '',
      hosts: [],
    })).toEqual({ kind: 'generic' });
  });
});
