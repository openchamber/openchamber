import * as path from 'node:path';
import * as vscode from 'vscode';
import { generateBridgeCommitMessage } from './bridge-git-special-runtime';
import { execGit } from './bridge-git-process-runtime';
import { readMagicPromptOverrides, readSettings } from './bridge-settings-runtime';
import { formatCommitMessageForScm, selectCommitFilePaths } from './git-commit-message';
import { getGitStatus } from './gitService';
import type { API as GitAPI, GitExtension, Repository } from './git.d';
import type { OpenCodeManager } from './opencode';

const localize = vscode.l10n.t;
const OPENCODE_WAIT_MS = 30_000;

let inFlight = false;

const getGitApi = async (): Promise<GitAPI | null> => {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) return null;
  const exports = gitExtension.isActive
    ? gitExtension.exports
    : (await gitExtension.activate());
  if (!exports.enabled) return null;
  return exports.getAPI(1);
};

const pickRepository = async (
  git: GitAPI,
  sourceControl?: vscode.SourceControl,
): Promise<Repository | undefined> => {
  const fromScm = sourceControl?.rootUri ? git.getRepository(sourceControl.rootUri) : null;
  if (fromScm) return fromScm;

  if (git.repositories.length === 0) return undefined;
  if (git.repositories.length === 1) return git.repositories[0];

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const fromEditor = git.getRepository(activeUri);
    if (fromEditor) return fromEditor;
  }

  const picked = await vscode.window.showQuickPick(
    git.repositories.map((repo) => ({
      label: path.basename(repo.rootUri.fsPath),
      description: repo.rootUri.fsPath,
      repo,
    })),
    {
      placeHolder: localize('Select a repository'),
      title: localize('OpenChamber: Generate Commit Message'),
    },
  );
  return picked?.repo;
};

const waitForOpenCodeApiUrl = async (manager: OpenCodeManager): Promise<string> => {
  const current = manager.getApiUrl();
  if (manager.getStatus() === 'connected' && current) return current;

  if (manager.getStatus() === 'disconnected' || manager.getStatus() === 'error') {
    await manager.start();
  }

  const ready = manager.getApiUrl();
  if (manager.getStatus() === 'connected' && ready) return ready;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error(localize('OpenChamber: OpenCode is not ready')));
    }, OPENCODE_WAIT_MS);

    const disposable = manager.onStatusChange((status, error) => {
      if (status === 'connected') {
        const apiUrl = manager.getApiUrl();
        if (!apiUrl) return;
        clearTimeout(timeout);
        disposable.dispose();
        resolve(apiUrl);
        return;
      }
      if (status === 'error') {
        clearTimeout(timeout);
        disposable.dispose();
        reject(new Error(error || localize('OpenChamber: OpenCode is not ready')));
      }
    });
  });
};

export const registerGenerateCommitMessageCommand = (
  context: vscode.ExtensionContext,
  manager: OpenCodeManager,
): void => {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'openchamber.generateCommitMessage',
      async (sourceControl?: vscode.SourceControl) => {
        if (inFlight) {
          vscode.window.setStatusBarMessage(localize('OpenChamber: Commit message generation already in progress'), 2000);
          return;
        }
        inFlight = true;
        try {
          const git = await getGitApi();
          if (!git) {
            vscode.window.showWarningMessage(localize('OpenChamber: Git extension not found'));
            return;
          }

          const repo = await pickRepository(git, sourceControl);
          if (!repo) {
            vscode.window.showWarningMessage(localize('OpenChamber: No Git repository found'));
            return;
          }

          await repo.status();
          const directory = repo.rootUri.fsPath;
          const status = await getGitStatus(directory, { mode: 'light' });
          const files = selectCommitFilePaths(status.files);
          if (files.length === 0) {
            vscode.window.showInformationMessage(localize('OpenChamber: No changes to generate a commit message for'));
            return;
          }

          const inputBefore = repo.inputBox.value;
          const generated = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.SourceControl,
              title: localize('OpenChamber: Generating commit message...'),
              cancellable: false,
            },
            async () => {
              const apiUrl = await waitForOpenCodeApiUrl(manager);
              const promptOverrides = readMagicPromptOverrides().overrides;
              return generateBridgeCommitMessage({
                directory,
                files,
                apiUrl,
                authHeaders: manager.getOpenCodeAuthHeaders(),
                settings: readSettings(),
                visiblePromptOverride: promptOverrides['git.commit.generate.visible'],
                instructionsPromptOverride: promptOverrides['git.commit.generate.instructions'],
                execGit,
              });
            },
          );

          if (repo.inputBox.value !== inputBefore) {
            vscode.window.setStatusBarMessage(localize('OpenChamber: Left your commit message unchanged'), 4000);
            return;
          }
          repo.inputBox.value = formatCommitMessageForScm(generated);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(localize('OpenChamber: Failed to generate commit message - {0}', message));
        } finally {
          inFlight = false;
        }
      },
    ),
  );
};
