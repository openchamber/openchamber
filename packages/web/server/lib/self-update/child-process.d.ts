import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { JsonObject } from '../shared/json-values.js';

declare module 'child_process' {
  function spawn(command: string, args: readonly string[], options: Omit<SpawnOptions, 'env' | 'stdio'> & {
    env: JsonObject;
    stdio: 'ignore' | ['ignore', number, number];
  }): ChildProcess;
}
