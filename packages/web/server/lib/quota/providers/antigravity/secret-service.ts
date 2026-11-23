/**
 * Read a Secret Service entry in process, without invoking a desktop
 * helper. Ported from the opencode fork's providers/secret-service.ts so
 * every quota surface performs the same in-place keyring read the fork's
 * auth bridges perform; entries are only ever read, never written back.
 */
export const lookupSecretService = async (service: string, username: string): Promise<string | undefined> => {
  if (process.platform !== 'linux') return undefined;

  // The binding discovers the session bus from DBUS_SESSION_BUS_ADDRESS,
  // falling back to $XDG_RUNTIME_DIR/bus (verified by probe: with XDG set
  // the read succeeds unaided). A process launched with neither (cron, a
  // non-user systemd unit, a detached or ssh spawn) finds no bus, and the
  // read below fails silently to undefined. The secret-tool readers this
  // helper replaced synthesized the canonical per-user address for exactly
  // that launch shape (opencode#2313); restore it here. When
  // XDG_RUNTIME_DIR is set it names the session bus instead: synthesizing
  // the canonical /run/user/<uid> address anyway would point the binding
  // at a bus that is not the session's whenever the runtime dir is
  // non-canonical (opencode#2473). An address already present — even a
  // bogus one — is never overridden.
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && typeof process.getuid === 'function') {
    const xdg = process.env.XDG_RUNTIME_DIR?.replace(/\/+$/, '');
    const path = xdg ? xdg + '/bus' : '/run/user/' + process.getuid() + '/bus';
    // D-Bus address values are percent-decoded by the bus parser, so a
    // literal % (or any byte outside the unreserved set) in the runtime
    // dir would otherwise name a different path than the configured one.
    const escaped = Array.from(new TextEncoder().encode(path), (byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9._/-]/.test(char) ? char : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }).join('');
    const address = 'unix:path=' + escaped;
    process.env.DBUS_SESSION_BUS_ADDRESS = address;
    // Under Bun, process.env is a JS-level copy: native addons read the
    // libc environment, which the assignment above never reaches (verified
    // by probe — libc getenv stays unset and the binding still fails).
    // Write the libc environment too where Bun provides the FFI for it;
    // under Node/Electron the assignment already propagates, so this is
    // skipped there.
    if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
      try {
        const bunFfiSpecifier = 'bun:ffi';
        const { dlopen, FFIType } = (await import(bunFfiSpecifier)) as {
          dlopen: (
            path: string,
            symbols: Record<string, { args: unknown[]; returns: unknown }>
          ) => { symbols: { setenv: (name: string, value: string, overwrite: number) => number } };
          FFIType: { cstring: unknown; int: unknown };
        };
        const libc = dlopen('libc.so.6', {
          setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.int], returns: FFIType.int }
        });
        libc.symbols.setenv('DBUS_SESSION_BUS_ADDRESS', address, 0);
      } catch {
        // No FFI route to the libc environment: keep the JS-level value.
      }
    }
  }

  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(service, username, { linux: { store: 'secret-service' } });
    const value = await entry.getPassword(AbortSignal.timeout(15_000));
    return value || undefined;
  } catch {
    return undefined;
  }
};
