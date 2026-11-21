import 'path';

declare module 'path' {
  interface PlatformPath {
    resolve(path: unknown): string;
  }
}

declare global {
  var Bun: { readonly version: string } | undefined;
}
