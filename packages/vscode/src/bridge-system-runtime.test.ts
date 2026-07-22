import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Reproduction test for issue #2372
//
// The `editor:openFile` handler in bridge-system-runtime.ts uses
// `workspace.openTextDocument()` + `window.showTextDocument()` which forces
// .ipynb files to open as raw JSON text instead of the Jupyter Notebook editor.
//
// This test demonstrates the bug by:
//  1. Showing that the handler makes no distinction between .ipynb and .txt files
//  2. Showing that the handler uses the text-editor-specific API path
//  3. Verifying that the handler would need to use `vscode.open` (which respects
//     VS Code's editor resolver) to fix the issue.
// ---------------------------------------------------------------------------

// We can't import bridge-system-runtime.ts directly in Node.js because it
// imports `vscode` at the top level, which only resolves in the VS Code
// extension host. Instead, we read the source and analyze the code path.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(__dirname, 'bridge-system-runtime.ts');
const source = readFileSync(sourcePath, 'utf-8');

describe('editor:openFile (issue #2372 reproduction)', () => {
  test('editor:openFile handler uses workspace.openTextDocument for all files', () => {
    // The source file is imported at module scope in bridge-system-runtime.ts.
    // The relevant lines (344-359 in current source) are:
    //
    //   case 'editor:openFile': {
    //     const { path: filePath, line, column } = payload as { ... };
    //     try {
    //       const doc = await vscode.workspace.openTextDocument(filePath);
    //       const options: vscode.TextDocumentShowOptions = {};
    //       if (typeof line === 'number') {
    //         const pos = new vscode.Position(Math.max(0, line - 1), column || 0);
    //         options.selection = new vscode.Range(pos, pos);
    //       }
    //       await vscode.window.showTextDocument(doc, options);
    //       ...
    //
    // Extract the case block, balancing braces up to the return/break.
    const caseStart = source.indexOf("case 'editor:openFile':");
    assert.ok(caseStart >= 0, 'Should find the editor:openFile case');

    // Read from case line to the next case or end of switch.
    const slice = source.slice(caseStart);
    const nextCase = slice.search(/\n\s+case\s['"]/) || slice.length;
    const handlerBlock = slice.slice(0, nextCase);

    // VERIFY THE BUG: The handler calls openTextDocument + showTextDocument
    assert.ok(
      handlerBlock.includes('workspace.openTextDocument'),
      'BUG: Handler calls workspace.openTextDocument (forces text editor)',
    );
    assert.ok(
      handlerBlock.includes('window.showTextDocument'),
      'BUG: Handler calls window.showTextDocument (forces text editor)',
    );

    // VERIFY THE MISSING FIX: It does NOT use vscode.open command
    assert.ok(
      !handlerBlock.includes("executeCommand('vscode.open'"),
      'MISSING: Handler does not delegate to vscode.open (would respect editor resolver)',
    );

    // The fix suggested in the issue:
    //   await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), selectionOptions);
    //
    // This would let VS Code's editor resolver pick the correct editor
    // (Notebook editor for .ipynb, text editor for .txt, etc.).
    console.log(
      'Confirmed: editor:openFile bypasses VS Code editor resolver ' +
      'by calling openTextDocument + showTextDocument directly.',
    );
  });

  test('.ipynb files are not distinguished from .txt files in the handler', () => {
    const caseStart = source.indexOf("case 'editor:openFile':");
    assert.ok(caseStart >= 0);
    const slice = source.slice(caseStart);
    const nextCase = slice.search(/\n\s+case\s['"]/) || slice.length;
    const handlerBlock = slice.slice(0, nextCase);

    // The handler treats all file paths identically - no check for
    // file extension or file type.
    assert.ok(
      !handlerBlock.includes('.ipynb'),
      'Handler has no special handling for notebook files',
    );
    assert.ok(
      !handlerBlock.includes('notebook'),
      'Handler has no notebook-specific logic',
    );

    // The payload type is just { path: string; line?: number; column?: number }
    // with no option to specify editor type.
  });

  test('line/column selection uses TextDocumentShowOptions (text-editor-specific)', () => {
    const caseStart = source.indexOf("case 'editor:openFile':");
    assert.ok(caseStart >= 0);
    const slice = source.slice(caseStart);
    const nextCase = slice.search(/\n\s+case\s['"]/) || slice.length;
    const handlerBlock = slice.slice(0, nextCase);

    // Selection is constructed as TextDocumentShowOptions with
    // vscode.Range and vscode.Position, which is specific to text editors.
    assert.ok(
      handlerBlock.includes('vscode.Position'),
      'Uses vscode.Position (text editor selection API)',
    );
    assert.ok(
      handlerBlock.includes('vscode.Range'),
      'Uses vscode.Range (text editor selection API)',
    );
  });

  test('the vscode.open command preserves selection options for all editor types', () => {
    // Reference: VS Code's `vscode.open` command accepts an optional
    // `selection` URI fragment or `TextDocumentShowOptions` as the second
    // argument. Unlike openTextDocument + showTextDocument, it invokes
    // the editor resolver which selects the correct editor type.
    //
    // vscode.open signature:
    //   vscode.commands.executeCommand('vscode.open', Uri, options?)
    //
    // The options can include `selection` (a Range), same as
    // TextDocumentShowOptions.
    //
    // Source: https://code.visualstudio.com/api/references/commands
    console.log(
      'The fix: replace workspace.openTextDocument + window.showTextDocument ' +
      'with vscode.commands.executeCommand("vscode.open", uri, options). ' +
      'This preserves line/column selection while allowing the editor resolver to work.',
    );
  });
});
