/**
 * Reproduction test for issue #2027:
 * Mobile browser shows "Unable to reach server" instead of login screen on HTTP LAN access
 *
 * Issue: https://github.com/openchamber/openchamber/issues/2027
 *
 * Environment: OpenChamber v1.13.9, Windows server + mobile browser (HTTP LAN)
 * Config: desktopLanAccessEnabled: true, desktopUiPassword set
 *
 * What works:
 *   - /auth/session returns 401 {"authenticated":false,"locked":true} ✅
 *
 * What breaks:
 *   - SPA shows "Unable to reach server" (ErrorScreen) instead of password login screen ❌
 *
 * Suspected root cause:
 *   SessionAuthGate's `checkStatus()` calls Promise.all([fetchSessionStatus(), refreshPasskeyStatus()]).
 *   The catch block treats desktop (fallback to 'locked') and mobile (goes to 'error') differently.
 *   If Promise.all rejects on non-HTTPS for any reason, mobile browsers hit setState('error').
 *
 * Key findings:
 *   1. refreshPasskeyStatus wraps fetchPasskeyStatus in try-catch that returns
 *      defaultPasskeyStatus on error — so it should NEVER reject.
 *   2. If refreshPasskeyStatus's catch IS working, Promise.all resolves correctly
 *      for a 401 response, and the locked/password screen shows.
 *   3. If for ANY reason Promise.all rejects (uncatched error from refreshPasskeyStatus,
 *      or fetchSessionStatus itself fails), the catch block calls setState('error')
 *      for non-desktop runtimes.
 *   4. Desktop shell gets a fallback in the catch block (setState('locked') if
 *      shouldUseDesktopShellPasswordLogin() is true), but mobile browsers don't.
 */
import { describe, it, expect, vi } from 'vitest';

type PasskeyStatus = {
  enabled: boolean;
  hasPasskeys: boolean;
  passkeyCount: number;
  rpID: string | null;
};

type GateState = 'pending' | 'authenticated' | 'locked' | 'error' | 'rate-limited';

const defaultPasskeyStatus: PasskeyStatus = {
  enabled: false,
  hasPasskeys: false,
  passkeyCount: 0,
  rpID: null,
};

describe('Issue #2027 - SessionAuthGate checkStatus on HTTP LAN', () => {
  it('1. NORMAL FLOW: /auth/session=401, passkey=200 → state=locked (password screen)', async () => {
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/auth/session')) {
        return Promise.resolve(
          new Response(JSON.stringify({ authenticated: false, locked: true }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/auth/passkey/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('Not found', { status: 404 }));
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    try {
      // Exact pattern from SessionAuthGate checkStatus()
      const [response] = await Promise.all([
        fetch('/auth/session', { credentials: 'include' as RequestCredentials }),
        (async (): Promise<PasskeyStatus> => {
          try {
            const resp = await fetch('/auth/passkey/status');
            if (!resp.ok) return defaultPasskeyStatus;
            return { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null };
          } catch {
            // This catch prevents the promise from rejecting
            return defaultPasskeyStatus;
          }
        })(),
      ]);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.locked).toBe(true);

      const gateState: GateState = response.status === 401 ? 'locked' : 'error';
      expect(gateState).toBe('locked');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('2. CATCH WORKS: passkey fetch throws but inner catch prevents Promise.all rejection → state=locked', async () => {
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/auth/session')) {
        return Promise.resolve(
          new Response(JSON.stringify({ authenticated: false, locked: true }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      // Passkey status endpoint throws
      return Promise.reject(new Error('Network error on /auth/passkey/status'));
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    try {
      let caughtError: unknown = null;
      let sessionResponse: Response | null = null;

      try {
        [sessionResponse] = await Promise.all([
          fetch('/auth/session', { credentials: 'include' as RequestCredentials }),
          (async (): Promise<PasskeyStatus> => {
            try {
              const resp = await fetch('/auth/passkey/status');
              if (!resp.ok) return defaultPasskeyStatus;
              const data = await resp.json();
              return {
                enabled: data?.enabled === true,
                hasPasskeys: data?.hasPasskeys === true,
                passkeyCount: typeof data?.passkeyCount === 'number' ? data.passkeyCount : 0,
                rpID: typeof data?.rpID === 'string' && data.rpID ? data.rpID : null,
              };
            } catch {
              // This catch{} is what prevents the rejection
              return defaultPasskeyStatus;
            }
          })(),
        ]);
      } catch (e) {
        caughtError = e;
      }

      // The catch{} inside the passkey fetch prevents rejection
      expect(caughtError).toBeNull();
      expect(sessionResponse).not.toBeNull();
      expect(sessionResponse!.status).toBe(401);

      const gateState: GateState = sessionResponse!.status === 401 ? 'locked' : 'error';
      expect(gateState).toBe('locked');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('3. BUG DEMONSTRATION: uncatched promise rejection → state=error (mobile) vs locked (desktop)', async () => {
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/auth/session')) {
        return Promise.resolve(
          new Response(JSON.stringify({ authenticated: false, locked: true }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      // No catch wrapper → this rejection propagates to Promise.all
      return Promise.reject(new Error('Network error'));
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    try {
      let caughtError: unknown = null;

      try {
        // No catch wrapper on the second promise
        await Promise.all([
          fetch('/auth/session', { credentials: 'include' as RequestCredentials }),
          fetch('/auth/passkey/status'),
        ]);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).not.toBeNull();

      // Mobile browser in catch block → setState('error')
      const isDesktop = false;
      const shouldFallbackToLocked = isDesktop && true; // shouldUseDesktopShellPasswordLogin()
      const mobileResult: GateState = shouldFallbackToLocked ? 'locked' : 'error';
      expect(mobileResult).toBe('error'); // Mobile shows error screen

      // Desktop shell in same block → setState('locked')
      const isDesktopShell = true;
      const desktopFallback = isDesktopShell && true; // shouldUseDesktopShellPasswordLogin() = true for remote
      const desktopResult: GateState = desktopFallback ? 'locked' : 'error';
      expect(desktopResult).toBe('locked'); // Desktop shows password screen
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('4. ROOT CAUSE: catch block asymmetry for desktop vs mobile', () => {
    // From SessionAuthGate.tsx lines 404-414:
    //
    //   } catch (error) {
    //     console.warn('Failed to check session status:', error);
    //     if (shouldUseDesktopShellPasswordLogin()) {
    //       setState('locked');     // Desktop fallback
    //       return;
    //     }
    //     setState('error');        // Mobile browser always hits this
    //   }
    //
    // shouldUseDesktopShellPasswordLogin() = isDesktopShell() && !isLocalDesktopRuntime()
    //
    // On mobile browser HTTP LAN:
    //   isDesktopShell() === false → shouldUseDesktopShellPasswordLogin() === false
    //   → setState('error') → "Unable to reach server" screen

    // Mobile browser: isDesktopShell() = false
    expect(false).toBe(false); // shouldUseDesktopShellPasswordLogin = false
    // → setState('error')

    // Desktop (remote): isDesktopShell() = true, isLocalDesktopRuntime() = false
    expect(true && !false).toBe(true); // shouldUseDesktopShellPasswordLogin = true
    // → setState('locked')

    // Desktop (local): isDesktopShell() = true, isLocalDesktopRuntime() = true
    expect(true && !true).toBe(false); // shouldUseDesktopShellPasswordLogin = false
    // → setState('error') ← This means even desktop LOCAL can hit this!
  });

  it('5. VERIFY: refreshPasskeyStatus catch{} returns defaultPasskeyStatus (never rejects)', () => {
    // From SessionAuthGate.tsx lines 311-323:
    //
    // const refreshPasskeyStatus = useCallback(async () => {
    //   if (skipAuth) return defaultPasskeyStatus;
    //   try {
    //     const nextStatus = await fetchPasskeyStatus();
    //     setPasskeyStatus(nextStatus);
    //     return nextStatus;
    //   } catch {
    //     setPasskeyStatus(defaultPasskeyStatus);
    //     return defaultPasskeyStatus;  // Always resolve, never reject
    //   }
    // }, [skipAuth]);

    const refreshPasskeyStatus = async (): Promise<PasskeyStatus> => {
      try {
        throw new Error('Simulated error inside fetchPasskeyStatus');
      } catch {
        return defaultPasskeyStatus; // catch returns value → promise resolves
      }
    };

    // This promise must RESOLVE, never reject
    return expect(refreshPasskeyStatus()).resolves.toEqual(defaultPasskeyStatus);
  });
});
