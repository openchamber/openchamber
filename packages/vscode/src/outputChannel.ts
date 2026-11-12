import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * The "OpenChamber" channel in the Output panel. VS Code also writes it to the
 * window's log folder, so a line here can be found after the fact; the
 * extension host's console output is not kept anywhere.
 */
export function getOutputChannel(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('OpenChamber');
  return channel;
}

export function disposeOutputChannel() {
  channel?.dispose();
  channel = undefined;
}
