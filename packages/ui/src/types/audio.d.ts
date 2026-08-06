/**
 * Ambient module declarations for audio asset imports.
 *
 * Vite resolves these imports to hashed asset URLs at build time; bare `tsc`
 * resolves them via these declarations so `packages/ui` type-checks without a
 * `vite/client` reference (the package type-checks with `tsc --noEmit`).
 */
declare module '*.aac' {
  const src: string;
  export default src;
}

declare module '*.mp3' {
  const src: string;
  export default src;
}
