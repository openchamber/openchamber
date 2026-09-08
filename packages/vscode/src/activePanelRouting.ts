/**
 * Pure selection logic shared by the session editor panel routing
 * (`*ToActivePanel` methods). Kept free of the `vscode` dependency so it can be
 * unit tested in isolation.
 *
 * A right-click command targets the panel the user is currently in. We prefer a
 * panel that is actively focused; otherwise we fall back to the panel that was
 * focused most recently. The caller is responsible for confirming the returned
 * id still maps to a live panel.
 */
export function pickActivePanelId(
  panels: Array<{ id: string; active: boolean }>,
  lastActivePanelId: string | null,
): string | null {
  const active = panels.find((panel) => panel.active);
  return active?.id ?? lastActivePanelId ?? null;
}
