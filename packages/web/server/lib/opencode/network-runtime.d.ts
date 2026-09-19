export function parseOpenCodeHealth(
  response: Response,
  protocol: 'legacy' | 'opencode2',
): Promise<{ version: string | null } | null>;
