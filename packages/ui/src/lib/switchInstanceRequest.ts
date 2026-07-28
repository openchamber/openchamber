/**
 * Cross-surface request to switch the active desktop instance (host) from a
 * keyboard shortcut. The keyboard handler cannot own the switch itself — the
 * real switch flow (probing, relay tunnel adoption, SSH connect, token
 * minting) lives inside the mounted `DesktopHostSwitcherDialog`. So the handler
 * only expresses intent via this event, and the switcher performs the switch.
 *
 * This is desktop-only. On web/mobile nothing listens, so dispatching is a safe
 * no-op (those surfaces have no unified host list).
 */

export const SWITCH_INSTANCE_EVENT = 'openchamber:switch-instance';

export type SwitchInstanceRequest =
  | { kind: 'direction'; direction: -1 | 1 }
  | { kind: 'index'; index: number };

/**
 * Monotonic id so multiple mounted listeners (the inline switcher can appear in
 * more than one place) act on a given request exactly once.
 */
let lastRequestId = 0;

export const requestSwitchInstance = (request: SwitchInstanceRequest): void => {
  if (typeof window === 'undefined') return;
  lastRequestId += 1;
  window.dispatchEvent(
    new CustomEvent<SwitchInstanceRequest & { requestId: number }>(SWITCH_INSTANCE_EVENT, {
      detail: { ...request, requestId: lastRequestId },
    }),
  );
};

/**
 * Given the ordered instance list, the active runtime key, and a request,
 * returns the index of the instance to switch to (or -1 when the request does
 * not resolve to a different, valid instance).
 *
 * - `direction`: cycles with wrap-around from the active instance.
 * - `index`: 1-based jump; out-of-range is a no-op.
 * Switching to the already-active instance is a no-op (returns -1).
 */
export const resolveSwitchInstanceTarget = (
  orderedRuntimeKeys: readonly string[],
  activeRuntimeKey: string,
  request: SwitchInstanceRequest,
): number => {
  if (orderedRuntimeKeys.length === 0) return -1;
  const activeIndex = orderedRuntimeKeys.indexOf(activeRuntimeKey);

  if (request.kind === 'index') {
    const target = request.index - 1;
    if (target < 0 || target >= orderedRuntimeKeys.length) return -1;
    return target === activeIndex ? -1 : target;
  }

  // direction cycle
  const from = activeIndex >= 0 ? activeIndex : (request.direction > 0 ? -1 : 0);
  const next = (from + request.direction + orderedRuntimeKeys.length) % orderedRuntimeKeys.length;
  if (next === activeIndex) return -1;
  return next;
};
