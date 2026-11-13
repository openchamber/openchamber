import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

/**
 * What Cmd/Ctrl+W closes in the desktop app.
 *
 * The window menu owns the shortcut, so the page cannot catch the key itself.
 * A surface with a tab of its own (a file open in the editor, a terminal, a
 * browser tab) registers here; the desktop shell is told whether one is
 * registered, and while one is, the shortcut arrives as an
 * `openchamber:close-tab` event instead of closing the window.
 *
 * The surface the user clicked or focused last wins. A surface's place is the
 * zone it sits in (`[data-context-zone]`), so a click on the zone's tab strip
 * counts as much as one in its content. When places nest, such as the header's
 * session tabs registered on the whole page around a zone with tabs, a click
 * counts for the innermost one, so a click in that zone goes to its tabs and
 * a click anywhere else, a zone without tabs included, to the sessions'.
 * Registering counts as being used, so a surface just shown wins until the
 * user goes elsewhere.
 */
type Target = { close: () => void; area: { current: Element | null }; usedAt: number };

const targets: Target[] = [];
let clock = 0;
let listening = false;

const report = (): void => {
  if (!hasDesktopInvoke()) return;
  void invokeDesktop('desktop_set_close_tab_target', { active: targets.length > 0 });
};

const placeOf = (element: Element): Element => element.closest('[data-context-zone]') ?? element;

const handleUse = (event: Event): void => {
  const node = event.target;
  if (!(node instanceof Node)) return;
  const hits: Array<{ target: Target; place: Element }> = [];
  for (const target of targets) {
    const area = target.area.current;
    const place = area ? placeOf(area) : null;
    if (place?.contains(node)) hits.push({ target, place });
  }
  // Only the innermost places count: a click in a zone with tabs goes to
  // them, not to a target around the zone.
  for (const hit of hits) {
    const outer = hits.some((other) => other.place !== hit.place && hit.place.contains(other.place));
    if (!outer) hit.target.usedAt = ++clock;
  }
};

const handleCloseTab = (): void => {
  let latest: Target | undefined;
  for (const target of targets) {
    if (!latest || target.usedAt > latest.usedAt) latest = target;
  }
  latest?.close();
};

export const registerCloseTabTarget = (close: () => void, area: { current: Element | null }): (() => void) => {
  if (!listening) {
    window.addEventListener('openchamber:close-tab', handleCloseTab);
    window.addEventListener('pointerdown', handleUse, true);
    // `focus`, captured: a click into a browser tab's page focuses its
    // `<webview>` with a `focus` event only, no `focusin` and no pointer event.
    window.addEventListener('focus', handleUse, true);
    listening = true;
  }
  const target: Target = { close, area, usedAt: ++clock };
  targets.push(target);
  report();
  return () => {
    const index = targets.indexOf(target);
    if (index >= 0) targets.splice(index, 1);
    report();
  };
};
