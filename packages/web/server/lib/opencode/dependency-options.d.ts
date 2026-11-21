import type { StdioOptions } from 'node:child_process';

declare module 'node:child_process' {
  interface ExecFileOptions {
    stdio?: StdioOptions;
  }
}
