declare module 'http-proxy' {
  import type { Agent, ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
  import type { Socket } from 'node:net';

  export interface ServerOptions {
    target?: string;
    agent?: Agent;
    changeOrigin?: boolean;
    timeout?: number;
    proxyTimeout?: number;
  }

  export type ErrorCallback<Failure = Error, Request = IncomingMessage, Response = ServerResponse> = (
    error: Failure,
    request: Request,
    response: Response | Socket,
  ) => void;

  export type ProxyReqCallback<ProxyRequest = ClientRequest, Request = IncomingMessage, Response = ServerResponse> = (
    proxyRequest: ProxyRequest,
    request: Request,
    response: Response,
  ) => void;

  export type ProxyResCallback<Request = IncomingMessage, Response = ServerResponse> = (
    proxyResponse: IncomingMessage,
    request: Request,
    response: Response,
  ) => void;
}
