/**
 * `@/lib/desktop` inside a shared page: a page in a browser is never the
 * desktop shell or VS Code. The bundled components only ask which runtime
 * they are in; the real module brings the runtime's auth and transport.
 */
export const isVSCodeRuntime = (): boolean => false;

export const isDesktopShell = (): boolean => false;
