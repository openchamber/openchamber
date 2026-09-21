// Resolves once the one-time app boot work that affects layout has been applied —
// notably persisted appearance/typography preferences (font size, spacing), which are
// loaded asynchronously and would otherwise reflow the UI a frame after first paint.
// The mobile splash gate (useFontsReady) awaits this so the first UI shown is final.

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
