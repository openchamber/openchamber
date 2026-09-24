/**
 * Whether this client can drive a page rather than only display one.
 *
 * The answer is the same fact the event stream declares to the server by
 * opening with `browser=1`, and it is what `browser.open` reports as
 * `drivable`. One function for both keeps the declaration and what the agent
 * is told from drifting apart.
 *
 * Only an Electron renderer hosts the Chromium view that can be driven; a
 * browser tab (web, hosted mobile, Capacitor) renders a display-only iframe.
 */
export const canDriveBrowserPage = (): boolean => (
  Boolean(globalThis.window?.__OPENCHAMBER_ELECTRON__)
);
