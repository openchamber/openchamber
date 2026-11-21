import type { IncomingMessage, ServerResponse } from 'node:http';

export interface BrowserControlResponse extends ServerResponse {
  status: (code: number) => BrowserControlResponse;
  json: (body: { error: string } | { granted: boolean } | { matched: boolean } | { preferredConnectionId: string }) => void;
}

export type BrowserControlHandler = (
  req: IncomingMessage & { body?: unknown; params: Record<string, string | undefined> },
  res: BrowserControlResponse,
  next: (error?: Error) => void,
) => void;

export interface BrowserControlApp {
  post: (path: string, ...handlers: BrowserControlHandler[]) => void;
  get: (path: string, handler: BrowserControlHandler) => void;
}
