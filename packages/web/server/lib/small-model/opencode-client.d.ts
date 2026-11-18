declare module '@opencode/client' {
  export * from '@opencode/client/promise';

  import type { OpenCode as PublishedOpenCode } from '@opencode/client/promise';

  export type OpenCodeClient = import('./contracts.js').SmallModelClient;
  export const OpenCode: Omit<typeof PublishedOpenCode, 'make'> & {
    make: (options: PublishedOpenCode.ClientOptions) => OpenCodeClient;
  };
}
