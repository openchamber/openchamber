/**
 * Where a click on the branch's pull request row leads. Desktop and web open
 * the Tracker's branch tab; the phone opens the item on its board, and VS Code,
 * which mounts no context panel, opens the URL in the browser. Those two need
 * the link, so a summary without one leaves the row a readout (`null`).
 */
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
