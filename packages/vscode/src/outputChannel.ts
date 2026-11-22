import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('OpenChamber');
  return channel;
}

export function disposeOutputChannel() {
  channel?.dispose();
  channel = undefined;
}
