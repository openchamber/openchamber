import { describe, expect, test } from 'bun:test';
import {
  resolveDesktopBootView,
  canDismissInitialLoading,
  getInjectedBootOutcome,
  getBootInjectionStatus,
  shouldRestartDesktopBootFlow,
} from './desktopBoot';

describe('resolveDesktopBootView', () => {
  test('returns chooser for first launch (not-configured)', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: { target: null, status: 'not-configured' },
      }),
    ).toEqual({ screen: 'chooser' });
  });

  test('returns recovery view for broken saved remote', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: {
          target: 'remote',
          status: 'unreachable',
          hostId: 'remote-a',
          url: 'https://x.test',
        },
      }),
    ).toEqual({ screen: 'recovery', variant: 'remote-unreachable', hostId: 'remote-a', url: 'https://x.test' });
  });

  test('returns main for local ok', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: { target: 'local', status: 'ok' },
      }),
    ).toEqual({ screen: 'main' });
  });

  test('returns main with hostId for remote ok', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: { target: 'remote', status: 'ok', hostId: 'remote-1', url: 'https://example.com' },
      }),
    ).toEqual({ screen: 'main', hostId: 'remote-1', url: 'https://example.com' });
  });

  test('returns recovery-remote for remote wrong-service', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: {
          target: 'remote',
          status: 'wrong-service',
          hostId: 'bad-host',
          url: 'https://bad.test',
        },
      }),
    ).toEqual({ screen: 'recovery', variant: 'remote-wrong-service', hostId: 'bad-host', url: 'https://bad.test' });
  });

  test('returns recovery view for local unreachable', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: { target: 'local', status: 'unreachable' },
      }),
    ).toEqual({ screen: 'recovery', variant: 'local-unavailable' });
  });

  test('returns recovery view for remote missing', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: { target: 'remote', status: 'missing', hostId: 'gone-1' },
      }),
    ).toEqual({ screen: 'recovery', variant: 'remote-missing', hostId: 'gone-1' });
  });

  test('returns null for non-desktop shell', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: false,
        bootOutcome: { target: 'local', status: 'ok' },
      }),
    ).toBeNull();
  });

  test('returns null when no boot outcome and desktop shell', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        bootOutcome: null,
      }),
    ).toBeNull();
  });
});

describe('canDismissInitialLoading', () => {
  test('does not dismiss desktop loading before boot outcome is known', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: true,
        isInitialized: true,
        bootOutcomeKnown: false,
      }),
    ).toBe(false);
  });

  test('dismisses desktop when main outcome is known and initialized', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: true,
        isInitialized: true,
        bootOutcomeKnown: true,
        bootViewIsMain: true,
      }),
    ).toBe(true);
  });

  test('does not dismiss desktop when main outcome is known but not initialized', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: true,
        isInitialized: false,
        bootOutcomeKnown: true,
        bootViewIsMain: true,
      }),
    ).toBe(false);
  });

  test('dismisses desktop for non-main outcome without waiting for init', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: true,
        isInitialized: false,
        bootOutcomeKnown: true,
        bootViewIsMain: false,
      }),
    ).toBe(true);
  });

  test('does not dismiss desktop for non-main outcome when outcome is not known', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: true,
        isInitialized: true,
        bootOutcomeKnown: false,
        bootViewIsMain: false,
      }),
    ).toBe(false);
  });

  test('dismisses non-desktop when initialized', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: false,
        isInitialized: true,
        bootOutcomeKnown: false,
      }),
    ).toBe(true);
  });

  test('does not dismiss non-desktop when not initialized', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: false,
        isInitialized: false,
        bootOutcomeKnown: false,
      }),
    ).toBe(false);
  });
});

describe('shouldRestartDesktopBootFlow', () => {
  test('restarts the desktop app when boot UI is running in the startup window', () => {
    expect(
      shouldRestartDesktopBootFlow({
        isTauriShell: true,
        isDesktopLocalOriginActive: false,
      }),
    ).toBe(true);
  });

  test('does not restart when the local desktop origin is already active', () => {
    expect(
      shouldRestartDesktopBootFlow({
        isTauriShell: true,
        isDesktopLocalOriginActive: true,
      }),
    ).toBe(false);
  });

  test('does not restart outside the tauri shell', () => {
    expect(
      shouldRestartDesktopBootFlow({
        isTauriShell: false,
        isDesktopLocalOriginActive: false,
      }),
    ).toBe(false);
  });
});

describe('getInjectedBootOutcome', () => {
  // Bun test runner does not provide `window`. Mock it for these tests.
  const mockWindow = () => {
    const w: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>).window = w;
    return w;
  };
  const restoreWindow = () => {
    delete (globalThis as Record<string, unknown>).window;
  };

  test('returns null when window global is undefined', () => {
    delete (globalThis as Record<string, unknown>).window;
    try {
      expect(getInjectedBootOutcome()).toBeNull();
    } finally {
      restoreWindow();
    }
  });

  test('returns null for malformed payload with unknown kind', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = { kind: 'unknown-kind' };
    try {
      expect(getInjectedBootOutcome()).toBeNull();
    } finally {
      restoreWindow();
    }
  });

  test('returns null for payload missing required hostId', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = { kind: 'main-remote', url: 'https://x.test' };
    try {
      expect(getInjectedBootOutcome()).toBeNull();
    } finally {
      restoreWindow();
    }
  });

  test('returns null for non-object payload', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = 'not-an-object';
    try {
      expect(getInjectedBootOutcome()).toBeNull();
    } finally {
      restoreWindow();
    }
  });

  test('returns valid outcome for well-formed main-local', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = { target: 'local', status: 'ok' };
    try {
      expect(getInjectedBootOutcome()).toEqual({ target: 'local', status: 'ok' });
    } finally {
      restoreWindow();
    }
  });

  test('returns null for payload with numeric kind', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = { kind: 42 };
    try {
      expect(getInjectedBootOutcome()).toBeNull();
    } finally {
      restoreWindow();
    }
  });
});

describe('resolveDesktopBootView validation', () => {
  test('returns null for unknown kind via default branch', () => {
    expect(
      resolveDesktopBootView({
        isDesktopShell: true,
        // @ts-expect-error — testing unknown kind
        bootOutcome: { kind: 'totally-unknown' },
      }),
    ).toBeNull();
  });
});

describe('getBootInjectionStatus', () => {
  const mockWindow = () => {
    const w: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>).window = w;
    return w;
  };
  const restoreWindow = () => {
    delete (globalThis as Record<string, unknown>).window;
  };

  test('returns "not-injected" when window is undefined', () => {
    delete (globalThis as Record<string, unknown>).window;
    try {
      expect(getBootInjectionStatus()).toBe('not-injected');
    } finally {
      restoreWindow();
    }
  });

  test('returns "not-injected" when global is absent', () => {
    mockWindow();
    // Do not set the global — it should be absent.
    try {
      expect(getBootInjectionStatus()).toBe('not-injected');
    } finally {
      restoreWindow();
    }
  });

  test('returns "not-injected" when global is explicitly null', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = null;
    try {
      expect(getBootInjectionStatus()).toBe('not-injected');
    } finally {
      restoreWindow();
    }
  });

  test('returns "malformed" when global is present but invalid', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = { kind: 'bad' };
    try {
      expect(getBootInjectionStatus()).toBe('malformed');
    } finally {
      restoreWindow();
    }
  });

  test('returns "valid" when global is present and well-formed', () => {
    const w = mockWindow();
    w.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = { target: 'local', status: 'ok' };
    try {
      expect(getBootInjectionStatus()).toBe('valid');
    } finally {
      restoreWindow();
    }
  });
});

describe('canDismissInitialLoading with malformed injection', () => {
  test('does NOT dismiss desktop splash when injection is malformed', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: true,
        isInitialized: true,
        bootOutcomeKnown: false,
      }),
    ).toBe(false);
  });

  test('dismisses desktop main outcome when valid and initialized', () => {
    expect(
      canDismissInitialLoading({
        isDesktopShell: true,
        isInitialized: true,
        bootOutcomeKnown: true,
        bootViewIsMain: true,
      }),
    ).toBe(true);
  });
});
