declare var __openchamberHmrState: import('./lib/opencode/hmr-state-runtime.js').HmrState | undefined;

declare module 'compression' {
  type Request = import('./lib/shared/http-contracts.js').Request;
  type Response = import('./lib/shared/http-contracts.js').Response;
  interface CompressionOptions {
    filter?: (req: Request, res: Response) => boolean;
    threshold?: number;
  }
  interface Compression {
    (options?: CompressionOptions): import('./lib/shared/http-contracts.js').RequestHandler;
    filter: (req: Request, res: Response) => boolean;
  }
  const compression: Compression;
  export default compression;
}

declare module 'web-push' {
  interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  interface SendResult {
    statusCode: number;
    body: string;
    headers: import('node:http').IncomingHttpHeaders;
  }
  const webPush: {
    generateVAPIDKeys: () => { publicKey: string; privateKey: string };
    setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
    sendNotification: (subscription: PushSubscription, payload: string) => Promise<SendResult>;
  };
  export default webPush;
}
