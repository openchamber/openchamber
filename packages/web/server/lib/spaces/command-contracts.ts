export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer | undefined;
  timeoutMs?: number;
  maxOutputBytes?: number;
  keepTail?: boolean;
  killTree?: boolean;
  keepAtExit?: boolean;
  signal?: AbortSignal | undefined;
  killWaitMs?: number;
}

export type RunCommand = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export interface SpaceExecOptions extends CommandOptions {
  target?: 'space' | 'gatekeeper';
}

export type SpaceExec = (spaceId: string, argv: string[], options?: SpaceExecOptions) => Promise<CommandResult>;
