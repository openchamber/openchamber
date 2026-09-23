import React from 'react';

/**
 * Where the Files editor is drawn right now: the slot inside the zone that
 * holds Files, how that zone wants it shown, and that zone's key handling.
 */
export type FilesEditorPlacement = {
  element: HTMLElement;
  visible: boolean;
  onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => void;
};

/**
 * Asked before the user leaves the file the editor has loaded (switching to
 * another file or closing it). The editor owns unsaved edits, so it decides:
 * it calls `proceed` at once when there is nothing to lose, or after the user
 * saves or discards.
 */
export type FilesEditorLeaveGuard = (leavingPath: string, proceed: () => void) => void;

type FilesEditorWorkspace = {
  getPlacement: () => FilesEditorPlacement | null;
  setPlacement: (next: FilesEditorPlacement | null) => void;
  subscribe: (listener: () => void) => () => void;
  setLeaveGuard: (guard: FilesEditorLeaveGuard | null) => void;
  guardLeave: FilesEditorLeaveGuard;
};

export const createFilesEditorWorkspace = (): FilesEditorWorkspace => {
  let placement: FilesEditorPlacement | null = null;
  let leaveGuard: FilesEditorLeaveGuard | null = null;
  const listeners = new Set<() => void>();
  return {
    getPlacement: () => placement,
    setPlacement: (next) => {
      placement = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLeaveGuard: (guard) => {
      leaveGuard = guard;
    },
    guardLeave: (leavingPath, proceed) => {
      if (leaveGuard) leaveGuard(leavingPath, proceed);
      else proceed();
    },
  };
};

export const FilesEditorContext = React.createContext<FilesEditorWorkspace | null>(null);

export const useFilesEditorWorkspace = (): FilesEditorWorkspace => {
  const workspace = React.useContext(FilesEditorContext);
  if (!workspace) throw new Error('Files editor slots and hosts must be inside FilesEditorProvider');
  return workspace;
};

/**
 * Runs a file navigation through the editor's unsaved-edit check. Outside a
 * workspace (no editor to protect) it runs the navigation directly.
 */
export const useGuardFileLeave = (): FilesEditorLeaveGuard => {
  const workspace = React.useContext(FilesEditorContext);
  return React.useCallback<FilesEditorLeaveGuard>((leavingPath, proceed) => {
    if (workspace) workspace.guardLeave(leavingPath, proceed);
    else proceed();
  }, [workspace]);
};

/** Lets the workspace's editor answer `useGuardFileLeave`. A no-op elsewhere. */
export const useRegisterFileLeaveGuard = (guard: FilesEditorLeaveGuard): void => {
  const workspace = React.useContext(FilesEditorContext);
  React.useEffect(() => {
    if (!workspace) return undefined;
    workspace.setLeaveGuard(guard);
    return () => workspace.setLeaveGuard(null);
  }, [guard, workspace]);
};
