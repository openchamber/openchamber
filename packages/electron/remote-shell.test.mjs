import { describe, expect, test } from 'bun:test';
import {
  OPENCHAMBER_UI_MARKER_ATTR,
  REMOTE_SHELL_BACK_BUTTON_ID,
  REMOTE_SHELL_BAR_ID,
  buildRemoteShellInjectionScript,
  remoteShellPageShouldInject,
} from './remote-shell.mjs';
describe('remoteShellPageShouldInject', () => {
  const foreignPage = () => ({
    protocol: 'http:',
    origin: 'http://100.64.0.10:3000',
    openChamberUiMarker: '',
    localOrigin: 'http://127.0.0.1:3901',
  });

  test('injects on a foreign http page (e.g. an opencode web server)', () => {
    expect(remoteShellPageShouldInject(foreignPage())).toBe(true);
  });

  test('skips OpenChamber UI documents via the marker, even at a remote origin', () => {
    expect(remoteShellPageShouldInject({
      ...foreignPage(),
      openChamberUiMarker: 'openchamber',
    })).toBe(false);
  });

  test('skips the page when its origin is the local OpenChamber origin', () => {
    expect(remoteShellPageShouldInject({
      ...foreignPage(),
      origin: 'http://127.0.0.1:3901',
    })).toBe(false);
    expect(remoteShellPageShouldInject({
      ...foreignPage(),
      localOrigin: 'http://100.64.0.10:3000',
    })).toBe(false);
  });

  test('skips non-http(s) pages (splash, devtools, packaged UI protocol)', () => {
    for (const protocol of ['data:', 'devtools:', 'openchamber-ui:', 'about:']) {
      expect(remoteShellPageShouldInject({ ...foreignPage(), protocol })).toBe(false);
    }
  });

  test('skips pages without a usable origin', () => {
    expect(remoteShellPageShouldInject({ ...foreignPage(), origin: '' })).toBe(false);
    expect(remoteShellPageShouldInject({ ...foreignPage(), origin: 'null' })).toBe(false);
  });

  test('skips when the local origin is unparseable only if it does not match', () => {
    // Unparseable local origin must not suppress injection on a foreign page.
    expect(remoteShellPageShouldInject({ ...foreignPage(), localOrigin: 'not a url' })).toBe(true);
  });
});

describe('buildRemoteShellInjectionScript', () => {
  test('produces parseable JavaScript', () => {
    const script = buildRemoteShellInjectionScript({ localUiUrl: 'http://127.0.0.1:3901' });
    expect(() => new Function(script)).not.toThrow();
  });

  test('embeds the local UI back target JSON-encoded', () => {
    const script = buildRemoteShellInjectionScript({ localUiUrl: 'http://127.0.0.1:3901' });
    expect(script).toContain('"http://127.0.0.1:3901"');
  });

  test('carries the marker attribute, bar id, and back button id', () => {
    const script = buildRemoteShellInjectionScript({ localUiUrl: 'openchamber-ui://app/index.html' });
    expect(script).toContain(OPENCHAMBER_UI_MARKER_ATTR);
    expect(script).toContain(REMOTE_SHELL_BAR_ID);
    expect(script).toContain(REMOTE_SHELL_BACK_BUTTON_ID);
    expect(script).toContain('openchamber-ui://app/index.html');
  });

  test('embeds the serialized guard so in-page and main-process rules match', () => {
    const script = buildRemoteShellInjectionScript({ localUiUrl: 'http://127.0.0.1:3901' });
    expect(script).toContain('openChamberUiMarker');
    // The marker comparison literal must be inlined (module constants are out
    // of scope in the page). Function.prototype.toString output differs by
    // runtime quoting, so accept both quote styles.
    expect(script.includes('"openchamber"') || script.includes("'openchamber'")).toBe(true);
  });

  test('skips injection when no back target is available', () => {
    const script = buildRemoteShellInjectionScript({ localUiUrl: '' });
    expect(script).toContain('if (!backTarget) return;');
  });

  test('contains no secrets or local filesystem data', () => {
    const script = buildRemoteShellInjectionScript({ localUiUrl: 'http://127.0.0.1:3901' });
    for (const forbidden of ['process.env', 'child_process', 'fs.', 'ipcRenderer', '__OPENCHAMBER_DESKTOP__']) {
      expect(script).not.toContain(forbidden);
    }
  });
});
