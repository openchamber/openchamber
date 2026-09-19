export function detectOpenCodeCliProtocol(
  launch: { binary: string; args: string[] },
  options?: { signal?: AbortSignal },
): Promise<'legacy' | 'opencode2'>;
