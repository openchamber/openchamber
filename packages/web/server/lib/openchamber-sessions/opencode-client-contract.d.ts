import type { OpenCode, OpenCodeClient, SessionGetInput, SessionInfo, SessionUpdateInput } from '@opencode/client';

export interface SessionRequestOptions extends Omit<OpenCode.RequestOptions, 'signal'> {
  signal?: AbortSignal | undefined;
}

export interface SessionClient extends Omit<OpenCodeClient, 'session' | 'experimental'> {
  session: Omit<OpenCodeClient['session'], 'get' | 'update'> & {
    get(input: SessionGetInput, options?: SessionRequestOptions): Promise<SessionInfo>;
    update(input: Omit<SessionUpdateInput, 'metadata'> & { metadata?: object | undefined }, options?: SessionRequestOptions): Promise<void>;
  };
  experimental: Omit<OpenCodeClient['experimental'], 'session'> & {
    session: Omit<OpenCodeClient['experimental']['session'], 'import'> & {
      import(input: { info: object; messages: unknown; location?: { readonly directory: string } | null | undefined }, options?: SessionRequestOptions): Promise<SessionInfo>;
    };
  };
}
