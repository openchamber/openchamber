type PrRowTarget = 'context-panel' | 'board' | 'browser';

export const resolvePrRowTarget = (input: {
  directory: string | null;
  prUrl: string | null;
  mobile: boolean;
  vscode: boolean;
}): PrRowTarget | null => {
  if (!input.directory) return null;
  if (input.vscode) return input.prUrl ? 'browser' : null;
  if (input.mobile) return input.prUrl ? 'board' : null;
  return 'context-panel';
};
