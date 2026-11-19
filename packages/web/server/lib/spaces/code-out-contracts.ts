import type fs from 'node:fs/promises';
import type { HostGit, RemoveDirectory } from './code-transfer.js';
import type { CommandOptions, CommandResult } from './command-contracts.js';
import type { SpaceError } from './errors.js';

export interface CodeOutPlace {
  execArgv: (spaceId: string) => Promise<string[]>;
  exec: (spaceId: string, argv: string[], options: CommandOptions) => Promise<CommandResult>;
}

export interface CodeOutOptions {
  git: HostGit;
  place: CodeOutPlace | null;
  temporaryDirectory?: string;
  removeDirectory?: RemoveDirectory;
  platform?: NodeJS.Platform;
  readBackTimeoutMs?: number;
  sizePollMs?: number;
  files?: Pick<typeof fs, 'open' | 'lstat' | 'readlink'>;
}

export interface CodeOutRequest {
  repository: string;
  spaceId: string;
  spacePath?: string | null;
  timeoutMs?: number;
  innerMarginSeconds?: number;
  maxTransferBytes?: number;
  maxChangedBytes?: number;
  maxChangedEntries?: number;
}

export interface ApplyRequest {
  repository: string;
  spaceId: string;
  maxChangedBytes?: number;
  maxChangedEntries?: number;
}

export interface NameOptions {
  ignoreCase: boolean;
  precompose: boolean;
}

export interface RedirectedFolderOptions extends Partial<NameOptions> {
  deletedLinks?: string[];
  lstat?: (file: string) => Promise<Pick<Awaited<ReturnType<typeof fs.lstat>>, 'isSymbolicLink' | 'isDirectory'>>;
  realpath?: (file: string) => Promise<string>;
}

export interface AllowedNameOptions extends Partial<NameOptions> {
  platform?: NodeJS.Platform;
  deleted?: string[];
  top?: string;
  longPaths?: boolean;
}

export interface NameNode {
  children: Map<string, NameNode>;
  spellings: Map<string, { present: boolean; old: boolean }>;
}

export interface ChangeLimits {
  maxChangedBytes: number;
  maxChangedEntries: number;
}

export interface ChangeRefusals {
  tooMany: (what: string, limit: number) => SpaceError<{ step?: string; limit: number }>;
  tooLarge: (bytes: number, limit: number) => SpaceError<{ step?: string; limit: number; newBytes?: number }>;
}

export interface TransferStepDetails {
  step: unknown;
  cause?: unknown;
}

export interface ReadFailureState {
  current: unknown;
}

export interface GitSide {
  mode: string | undefined;
  id: string | undefined;
}

export interface ComparedPath {
  path: string;
  from: GitSide;
  to: GitSide;
}

export interface FileReading {
  kind: 'absent' | 'other' | 'link' | 'file';
  raw?: string;
  clean?: string | undefined;
  executable?: boolean;
}

export interface ReadBackSettings {
  algorithm: string;
  filemode: boolean;
  symlinks: boolean;
}

export interface Patch {
  file: string;
  check: CommandResult | null;
}

export interface ApplyCall {
  g: HostGit;
  directory: string;
  top: string;
  until: number;
  listings: Map<string, string[]>;
  patches: Map<string, Patch>;
  files: number;
  settings: ReadBackSettings | null;
  readings: Map<string, FileReading>;
  folders: Map<string, boolean>;
  commits: Map<string, Set<string>>;
}

export interface ReportedPaths {
  count: number;
  paths: string[];
}

export interface CodeOutSummary {
  result: string;
  changedPaths: number;
  changedBytes: number;
  nestedRepositories: ReportedPaths;
  newBytes: number;
  unmerged: ReportedPaths;
}

export interface ApplyState {
  changesRoute: 'closed' | 'open';
  result: string | null;
  lastApplied: string | null;
  newPaths: number | null;
  newPathsOverLimit: boolean;
  newPathsUndecided: boolean;
  interruptedApply: boolean;
}

export type ApplyChangesResult = { status: 'nothing_to_apply' } | {
  status: 'applied';
  appliedPaths: number;
  remembered: boolean;
  nestedRepositories: ReportedPaths;
  conflicted: ReportedPaths;
};
