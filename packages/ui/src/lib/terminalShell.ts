import type { TerminalShell } from '@/lib/api/types';

const TERMINAL_SHELL_IDS = ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'] as const satisfies ReadonlyArray<Exclude<TerminalShell, 'auto'>>;

export const isTerminalShell = (value: unknown): value is TerminalShell => (
  value === 'auto' || (typeof value === 'string' && TERMINAL_SHELL_IDS.includes(value as Exclude<TerminalShell, 'auto'>))
);
