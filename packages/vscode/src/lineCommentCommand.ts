import * as vscode from 'vscode';

import { writesInChatComposer, type InlineCommentThreads } from './InlineCommentThreads';

const t = vscode.l10n.t;

type LineCommentArgument = vscode.Uri | { uri: vscode.Uri; lineNumber: number };

const gutterTargetOf = (argument: LineCommentArgument | undefined): { uri: vscode.Uri; lineNumber: number } | undefined => {
    if (!argument || argument instanceof vscode.Uri) return undefined;
    const { uri, lineNumber } = argument;
    if (uri && Number.isInteger(lineNumber) && lineNumber >= 1) return { uri, lineNumber };
    console.warn('[openchamber] addLineComment: no usable line number in the command argument', argument);
    return undefined;
};

const commentTargetOf = async (argument: LineCommentArgument | undefined): Promise<{ uri: vscode.Uri; range: vscode.Range } | undefined> => {
    const gutter = gutterTargetOf(argument);
    if (gutter) {
        const document = await vscode.workspace.openTextDocument(gutter.uri);
        return { uri: document.uri, range: document.lineAt(Math.min(gutter.lineNumber, document.lineCount) - 1).range };
    }
    const editor = vscode.window.activeTextEditor;
    return editor ? { uri: editor.document.uri, range: editor.selection } : undefined;
};

export const registerAddLineCommentCommand = (threads: InlineCommentThreads): vscode.Disposable =>
    vscode.commands.registerCommand('openchamber.addLineComment', async (argument?: LineCommentArgument) => {
        const target = await commentTargetOf(argument);
        if (!target) {
            vscode.window.showWarningMessage(t('OpenChamber [Add Comment]: No active editor'));
            return;
        }
        if (!threads.canCommentOn(target.uri)) {
            vscode.window.showWarningMessage(t('OpenChamber [Add Comment]: File is outside the workspace'));
            return;
        }
        if (writesInChatComposer()) await threads.composeInChat(target.uri, target.range);
        else threads.openThread(target.uri, target.range);
    });
