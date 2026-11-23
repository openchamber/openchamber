export function pickActivePanelId(
  panels: Array<{ id: string; active: boolean }>,
  lastActivePanelId: string | null,
): string | null {
  const active = panels.find((panel) => panel.active);
  return active?.id ?? lastActivePanelId ?? null;
}
