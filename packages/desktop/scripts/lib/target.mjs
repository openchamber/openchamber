export function inferTargetTriple() {
  if (typeof process.env.TAURI_ENV_TARGET_TRIPLE === 'string' && process.env.TAURI_ENV_TARGET_TRIPLE.trim()) {
    return process.env.TAURI_ENV_TARGET_TRIPLE.trim();
  }

  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }

  if (process.platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }

  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }

  return `${process.arch}-${process.platform}`;
}
