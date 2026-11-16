
let resolveBoot: (() => void) | null = null;
let resolved = false;

export const appBootReadyPromise = new Promise<void>((resolve) => {
  resolveBoot = resolve;
});

export function markAppBootReady(): void {
  if (resolved) return;
  resolved = true;
  resolveBoot?.();
}
