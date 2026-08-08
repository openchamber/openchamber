import * as vscode from 'vscode';

export const isCursorLikeHost = (): boolean => /\bcursor\b/i.test(vscode.env.appName);

export const findMoveToRightSidebarCommandId = async (): Promise<string | null> => {
  const commands = await vscode.commands.getCommands(true);

  const preferred = [
    // Newer VS Code naming
    'workbench.action.moveViewToSecondarySideBar',
    'workbench.action.moveViewToSecondarySidebar',
    'workbench.action.moveFocusedViewToSecondarySideBar',
    'workbench.action.moveFocusedViewToSecondarySidebar',

    // Some builds use "Auxiliary Bar" naming
    'workbench.action.moveViewToAuxiliaryBar',
    'workbench.action.moveFocusedViewToAuxiliaryBar',
  ];

  for (const commandId of preferred) {
    if (commands.includes(commandId)) return commandId;
  }

  const fuzzy = commands.find((commandId) => {
    const id = commandId.toLowerCase();
    const looksLikeMoveView = id.includes('workbench.action') && id.includes('move') && id.includes('view');
    if (!looksLikeMoveView) return false;

    // Support both "secondary sidebar" and "auxiliary bar" naming.
    return (id.includes('secondary') && id.includes('side') && id.includes('bar')) || (id.includes('auxiliary') && id.includes('bar'));
  });

  return fuzzy || null;
};

export const attemptMoveChatToRightSidebar = async (
  outputChannel?: vscode.OutputChannel,
): Promise<'moved' | 'unsupported' | 'failed'> => {
  const moveCommandId = await findMoveToRightSidebarCommandId();
  if (!moveCommandId) return 'unsupported';

  try {
    await vscode.commands.executeCommand('openchamber.chatView.focus');
    await vscode.commands.executeCommand(moveCommandId);
    return 'moved';
  } catch (error) {
    outputChannel?.appendLine(
      `[OpenChamber] Failed moving chat view to right sidebar (command=${moveCommandId}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
};

export const maybeMoveChatToRightSidebarOnStartup = (
  context: vscode.ExtensionContext,
  outputChannel?: vscode.OutputChannel,
): void => {
  if (isCursorLikeHost()) return;

  let moveToRightSidebarScheduled = false;

  const attempted = context.globalState.get<boolean>('openchamber.sidebarAutoMoveAttempted') || false;
  if (attempted) return;
  void context.globalState.update('openchamber.sidebarAutoMoveAttempted', true);

  if (moveToRightSidebarScheduled) return;
  moveToRightSidebarScheduled = true;

  // Defer until after activation to avoid stealing focus during startup.
  setTimeout(() => {
    void (async () => {
      try {
        await attemptMoveChatToRightSidebar(outputChannel);
      } finally {
        moveToRightSidebarScheduled = false;
      }
    })();
  }, 800);
};
