import type * as vscode from 'vscode';
import type { OpenCodeManager } from './opencode';

export interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

export interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgeContext {
  manager?: OpenCodeManager;
  context?: vscode.ExtensionContext;
}
