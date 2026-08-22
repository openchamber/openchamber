export function getGitViewRenderMode(input: {
  screenWidth: number;
  isMobile: boolean;
  isDesktopShell: boolean;
  isVSCode: boolean;
}): 'workspace-panes' | 'legacy-inline' {
  if (input.isMobile || input.isVSCode) {
    return 'legacy-inline';
  }

  if (input.isDesktopShell) {
    return 'workspace-panes';
  }

  return input.screenWidth <= 768 ? 'legacy-inline' : 'workspace-panes';
}
