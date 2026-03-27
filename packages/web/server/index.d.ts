import type { Express } from "express";
import type { Server } from "http";

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  isReady: () => boolean;
  restartOpenCode: () => Promise<void>;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
};
