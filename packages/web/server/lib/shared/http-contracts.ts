import type { IncomingMessage, OutgoingHttpHeader, Server, ServerResponse } from 'node:http';
import type { ListenOptions } from 'node:net';

export type QueryValue = string | QueryValue[] | { [key: string]: QueryValue | undefined };
export type Query = Record<string, QueryValue | undefined>;

export interface Request<Body = unknown, Params = Record<string, string>, Search = Query> extends IncomingMessage {
  url: string;
  body: Body;
  params: Params;
  query: Search;
  originalUrl: string;
  baseUrl: string;
  path: string;
  protocol: string;
  hostname: string;
  ip: string | undefined;
  ips: string[];
  secure: boolean;
  get(name: 'set-cookie'): string[] | undefined;
  get(name: 'x-opencode-directory' | 'x-opencode-directory-encoding'): string | undefined;
  get(name: string): string | string[] | undefined;
  header(name: 'set-cookie'): string[] | undefined;
  header(name: string): string | string[] | undefined;
  is(type: string): string | false | null;
}

export interface Response<Body = unknown> extends ServerResponse {
  status<Code>(code: Code): this;
  json(body: Body): this;
  send(body?: Body): this;
  sendStatus(code: number): this;
  set(name: string, value: string | readonly string[]): this;
  set(headers: Record<string, string | readonly string[]>): this;
  header(name: string, value: string | readonly string[]): this;
  get(name: string): OutgoingHttpHeader | undefined;
  type(contentType: string): this;
  format(handlers: Record<string, RequestHandler>): this;
  redirect(url: string): void;
  redirect(status: number, url: string): void;
  sendFile(filePath: string, options?: SendFileOptions, callback?: (error: Error | undefined) => void): void;
}

export interface SendFileOptions {
  root?: string;
  dotfiles?: 'allow' | 'deny' | 'ignore';
  headers?: Record<string, string>;
  maxAge?: number | string;
  lastModified?: boolean;
  acceptRanges?: boolean;
  cacheControl?: boolean;
  immutable?: boolean;
}

export type NextFunction = (cause?: unknown) => void;
export type RequestHandler<Body = unknown, Params = Record<string, string>, Search = Query> = (
  request: Request<Body, Params, Search>,
  response: Response,
  next: NextFunction,
) => void | Response | Promise<void | Response>;

export type ErrorRequestHandler = (
  cause: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
) => void | Response | Promise<void | Response>;

export interface Router {
  (request: IncomingMessage, response: ServerResponse, next?: NextFunction): void;
  get<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp | string[], ...handlers: RequestHandler<Body, Params, Search>[]): this;
  post<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp | string[], ...handlers: RequestHandler<Body, Params, Search>[]): this;
  put<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp, ...handlers: RequestHandler<Body, Params, Search>[]): this;
  patch<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp, ...handlers: RequestHandler<Body, Params, Search>[]): this;
  delete<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp | string[], ...handlers: RequestHandler<Body, Params, Search>[]): this;
  options<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp, ...handlers: RequestHandler<Body, Params, Search>[]): this;
  head<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp, ...handlers: RequestHandler<Body, Params, Search>[]): this;
  all<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp, ...handlers: RequestHandler<Body, Params, Search>[]): this;
  use(...handlers: RequestHandler[]): this;
  use<Body = unknown, Params = Record<string, string>, Search = Query>(route: string | RegExp | string[], ...handlers: RequestHandler<Body, Params, Search>[]): this;
  use(...handlers: ErrorRequestHandler[]): this;
  use(route: string | RegExp, ...handlers: ErrorRequestHandler[]): this;
}

export interface Application extends Router {
  set(name: string, value: string | number | boolean): this;
  disable(name: string): this;
  enable(name: string): this;
  listen(port: number, hostname?: string, callback?: () => void): Server;
  listen(port: number, callback?: () => void): Server;
  listen(options: ListenOptions, callback?: () => void): Server;
}

export interface JsonOptions {
  limit?: number | string;
  strict?: boolean;
  inflate?: boolean;
  type?: string | string[] | ((request: IncomingMessage) => boolean);
  verify?(request: IncomingMessage, response: ServerResponse, buffer: Buffer, encoding: string): void;
}

export interface ExpressFactory {
  (): Application;
  json(options?: JsonOptions): (request: IncomingMessage & { body?: unknown }, response: ServerResponse, next: (error?: Error) => void) => void;
  raw(options?: JsonOptions): RequestHandler;
  text(options?: JsonOptions & { defaultCharset?: string }): RequestHandler;
  urlencoded(options?: JsonOptions & { extended?: boolean; parameterLimit?: number }): RequestHandler;
  Router(options?: { caseSensitive?: boolean; mergeParams?: boolean; strict?: boolean }): Router;
  static(root: string, options?: SendFileOptions & {
    index?: string | string[] | false;
    fallthrough?: boolean;
    setHeaders?: (response: ServerResponse, filePath: string, stat: import('node:fs').Stats) => void;
  }): RequestHandler;
}
