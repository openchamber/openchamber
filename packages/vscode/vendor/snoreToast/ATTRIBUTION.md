# Vendored toast helper (Windows)

`snoretoast-x64.exe` / `snoretoast-x86.exe` are unmodified builds of
[SnoreToast](https://github.com/KDE/snoretoast) (by Hannah von Reth),
shipped so the VS Code extension can raise real Windows Action Center
toasts. `vscode.window.show*Message` only renders inside the VS Code
window and can never reach the OS notification center, so this helper
is the only path to OS-level parity with the desktop app.

- License: GNU LGPL-3.0, full text in `COPYING.LGPL-3`.
- Source: https://github.com/KDE/snoretoast
- The binaries are used as-is (spawned as a separate process, never
  linked). Same binaries as vendored by the `node-notifier` npm package.
