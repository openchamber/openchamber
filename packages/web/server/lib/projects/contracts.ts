import { z } from 'zod';

const sharedProjectDocumentSchema = z.record(z.string(), z.unknown());
export type SharedProjectDocument = z.infer<typeof sharedProjectDocumentSchema>;
export type ActionPlatform = 'macos' | 'linux' | 'windows';

export interface ProjectAction {
  id: string;
  name: string;
  command: string;
  icon: string | null;
  autoOpenUrl?: true;
  openUrl?: string;
  desktopOpenSshForward?: string;
  platforms?: ActionPlatform[];
  runIn?: 'parent';
}

export interface DraftStarter {
  type: 'command' | 'skill';
  name: string;
}

export interface SharedProjectConfig {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  teardownWorktree: string[];
  projectActions: ProjectAction[];
  draftStarters: DraftStarter[];
  plansDir: string | null;
}

export interface PersonalProjectSetup extends Omit<SharedProjectConfig, 'plansDir'> {
  setupWorktreeMode: 'append' | 'replace';
  createWorktreeCommand: string;
  projectActionsPrimaryId: string | null;
  hiddenSharedActionIds: string[];
  sharedTrust: { hash: string; trustedAt: number } | null;
  notesTodosInRepository: boolean;
}

export type SharedProjectRead =
  | { status: 'ok'; config: SharedProjectConfig; document: SharedProjectDocument }
  | { status: 'missing'; document?: never }
  | { status: 'invalid'; reason: string; document?: SharedProjectDocument };

export interface StoredProjectSetupPatch {
  'setup-worktree'?: string[];
  'setup-worktree-wait'?: boolean;
  teardownWorktree?: string[];
  createWorktreeCommand?: string | undefined;
  projectActions?: ProjectAction[];
  projectActionsPrimaryId?: string | undefined;
  draftStarters?: DraftStarter[];
  hiddenSharedActionIds?: string[];
  setupWorktreeMode?: 'append' | 'replace';
  sharedTrust?: { hash: string; trustedAt: number } | undefined;
  notesTodosInRepository?: true | undefined;
  projectPath?: string;
}

export interface WorktreeSetupInput {
  setupWorktree: string[];
  trust: { trusted: boolean };
  shared: { setupWorktree: string[] };
  personal: {
    setupWorktree: string[];
    setupWorktreeMode: PersonalProjectSetup['setupWorktreeMode'];
    createWorktreeCommand?: string;
  };
}

export interface WorktreeSetup {
  startCommand: string;
  createCommand: string;
  untrustedSkipped: string[];
}
