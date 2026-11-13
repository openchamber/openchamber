/**
 * `protectedClientConfig` is the protected MCP client configuration path, the
 * installed one by default; null leaves protected selections out entirely.
 */
export function materializeLocalMcpPlugin(options: { readonly dataDir: string; readonly protectedClientConfig?: string | null }): Promise<string>;
