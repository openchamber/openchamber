declare module 'ws' {
  export const WebSocket: import('./websocket-contracts.js').WebSocketConstructor;
  export type WebSocket = import('./websocket-contracts.js').WebSocket;
  export const WebSocketServer: import('./websocket-contracts.js').WebSocketServerConstructor;
  export type WebSocketServer = import('./websocket-contracts.js').WebSocketServer;
  export type RawData = import('./websocket-contracts.js').RawData;
  export type ClientOptions = import('./websocket-contracts.js').ClientOptions;
  export type ServerOptions = import('./websocket-contracts.js').ServerOptions;
  export default WebSocket;
}
