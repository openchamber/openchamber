export function runOpenCodeCliUpgrade(
  launch: { binary: string; args: string[] },
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void>;
