import type { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, Server } from 'node:http';
import type { ClientRequestArgs } from 'node:http';
import type { Duplex } from 'node:stream';

export type RawData = Buffer | ArrayBuffer | Buffer[];
export type SendData = string | Buffer | ArrayBuffer | ArrayBufferView | Buffer[];

export interface ClientOptions extends ClientRequestArgs {
  handshakeTimeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  maxPayload?: number;
  perMessageDeflate?: boolean;
  protocolVersion?: number;
  origin?: string;
  rejectUnauthorized?: boolean;
}

export interface WebSocketEvents<Data extends RawData = RawData> {
  open: [];
  message: [data: Data, isBinary: boolean];
  close: [code: number, reason: Buffer];
  error: [error: Error];
  ping: [data: Buffer];
  pong: [data: Buffer];
  'unexpected-response': [request: ClientRequest, response: IncomingMessage];
  upgrade: [response: IncomingMessage];
}

export interface WebSocketConstructor {
  new(address: string | URL, options?: ClientOptions): WebSocket<Buffer>;
  new(address: string | URL, protocols?: string | readonly unknown[], options?: ClientOptions): WebSocket<Buffer>;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

export interface WebSocket<Data extends RawData = RawData> extends EventEmitter<WebSocketEvents<Data>> {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  readonly extensions: string;
  readonly url: string;
  binaryType: Data extends Buffer ? 'nodebuffer' : Data extends ArrayBuffer ? 'arraybuffer' : Data extends Buffer[] ? 'fragments' : never;
  send(data: SendData, callback?: (error?: Error) => void): void;
  send(data: SendData, options: { binary?: boolean; compress?: boolean; fin?: boolean; mask?: boolean }, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string | Buffer): void;
  terminate(): void;
  ping(data?: SendData, mask?: boolean, callback?: (error?: Error) => void): void;
  pong(data?: SendData, mask?: boolean, callback?: (error?: Error) => void): void;
  pause(): void;
  resume(): void;
}

export interface WebSocketServerEvents<Data extends RawData = RawData> {
  connection: [socket: WebSocket<Data>, request: IncomingMessage];
  error: [error: Error];
  close: [];
  listening: [];
  headers: [headers: string[], request: IncomingMessage];
}

export interface ServerOptions {
  noServer?: boolean;
  server?: Server;
  port?: number;
  host?: string;
  path?: string;
  clientTracking?: boolean;
  maxPayload?: number;
  perMessageDeflate?: boolean;
  handleProtocols?(protocols: Set<string>, request: IncomingMessage): string | false;
}

export interface WebSocketServerConstructor {
  new<Data extends RawData = RawData>(options?: ServerOptions, callback?: () => void): WebSocketServer<Data>;
}

export interface WebSocketServer<Data extends RawData = RawData> extends EventEmitter<WebSocketServerEvents<Data>> {
  readonly clients: Set<WebSocket<Data>> | undefined;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket<Data>, request: IncomingMessage) => void): void;
  close(callback?: (error?: Error) => void): void;
  address(): { port: number; family: string; address: string } | string | null;
}
