import type * as vscode from 'vscode';

export type SidebarMoveResult = 'moved' | 'unsupported' | 'failed';

const PREFERRED_MOVE_COMMANDS = [
  'workbench.action.moveViewToSecondarySideBar',
  'workbench.action.moveViewToSecondarySidebar',
  'workbench.action.moveFocusedViewToSecondarySideBar',
  'workbench.action.moveFocusedViewToSecondarySidebar',
  'workbench.action.moveViewToAuxiliaryBar',
  'workbench.action.moveFocusedViewToAuxiliaryBar',
] as const;

export const isCursorLikeHost = (appName: string): boolean => /\bcursor\b/i.test(appName);

export const findMoveToRightSidebarCommandId = (commands: readonly string[]): string | null => {
  for (const commandId of PREFERRED_MOVE_COMMANDS) {
    if (commands.includes(commandId)) return commandId;
  }

  const fuzzy = commands.find((commandId) => {
    const id = commandId.toLowerCase();
    const looksLikeMoveView = id.includes('workbench.action') && id.includes('move') && id.includes('view');
    if (!looksLikeMoveView) return false;
    return (id.includes('secondary') && id.includes('side') && id.includes('bar'))
      || (id.includes('auxiliary') && id.includes('bar'));
  });

  return fuzzy || null;
};

export type SidebarPlacementDeps = {
  context: vscode.ExtensionContext;
  appName: string;
  getCommands: () => Thenable<string[]>;
  executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
  logFailure: (message: string) => void;
  delayMs?: number;
};

/**
 * One-shot startup attempt to move the chat view to the secondary sidebar on
 * VS Code (skipped on Cursor-like hosts). Persists that an attempt was made
 * so we do not keep fighting the user's layout.
 */
export const maybeMoveChatToRightSidebarOnStartup = (deps: SidebarPlacementDeps): void => {
  if (isCursorLikeHost(deps.appName)) return;

  const attempted = deps.context.globalState.get<boolean>('openchamber.sidebarAutoMoveAttempted') || false;
  if (attempted) return;

  void deps.context.globalState.update('openchamber.sidebarAutoMoveAttempted', true);

  const delayMs = deps.delayMs ?? 800;
  setTimeout(() => {
    void (async () => {
      try {
        await attemptMoveChatToRightSidebar(deps);
      } catch (error) {
        deps.logFailure(
          `[OpenChamber] Failed moving chat view to right sidebar: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }, delayMs);
};

const attemptMoveChatToRightSidebar = async (
  deps: Pick<SidebarPlacementDeps, 'getCommands' | 'executeCommand' | 'logFailure'>,
): Promise<SidebarMoveResult> => {
  const commands = await deps.getCommands();
  const moveCommandId = findMoveToRightSidebarCommandId(commands);
  if (!moveCommandId) return 'unsupported';

  try {
    await deps.executeCommand('openchamber.chatView.focus');
    await deps.executeCommand(moveCommandId);
    return 'moved';
  } catch (error) {
    deps.logFailure(
      `[OpenChamber] Failed moving chat view to right sidebar (command=${moveCommandId}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
};
