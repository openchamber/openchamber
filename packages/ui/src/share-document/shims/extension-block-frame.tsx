/**
 * `ExtensionBlockFrame` inside a shared page. No extension is active for a
 * reader (`extension-blocks.ts`), so no block names one and this never draws;
 * the real frame would bring the app's extension host into the page.
 */
export function ExtensionBlockFrame(): null {
  return null;
}
