import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';

// ── Types ──────────────────────────────────────────────────────────────────────

export type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

export type FileStatSnapshot = {
  path: string;
  size: number;
  mtimeMs?: number;
};

export type SelectedLineRange = {
  start: number;
  end: number;
};

export type FileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

export type FileLineEnding = '\n' | '\r\n';

// ── Constants ──────────────────────────────────────────────────────────────────

export const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

export const MAX_VIEW_CHARS = 200_000;

export const FILE_EDITOR_AUTO_SAVE_KEY = 'openchamber:files:auto-save-enabled';

// ── Path Helpers ───────────────────────────────────────────────────────────────

export const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');

  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
};

export const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

const toComparablePath = (value: string): string => {
  if (/^[A-Za-z]:\//.test(value)) {
    return value.toLowerCase();
  }
  return value;
};

export const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
};

export const getParentDirectoryPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) {
    return normalized;
  }
  if (lastSlash === 0) {
    return '/';
  }

  const parent = normalized.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}/`;
  }
  return parent;
};

export const getAncestorPaths = (filePath: string, root: string): string[] => {
  const normalizedRoot = normalizePath(root);
  const normalizedFile = normalizePath(filePath);

  // Ensure file is within root
  if (!isPathWithinRoot(normalizedFile, normalizedRoot)) return [];

  const relative = normalizedFile.slice(normalizedRoot.length).replace(/^\//, '');
  const parts = relative.split('/');
  const ancestors: string[] = [];
  let current = normalizedRoot;

  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    ancestors.push(current);
  }
  return ancestors;
};

export const getDisplayPath = (root: string | null, path: string): string => {
  if (!path) {
    return '';
  }

  const normalizedFilePath = normalizePath(path);
  if (!root || !isPathWithinRoot(normalizedFilePath, root)) {
    return normalizedFilePath;
  }

  const relative = normalizedFilePath.slice(root.length);
  return relative.startsWith('/') ? relative.slice(1) : relative;
};

// ── File Helpers ───────────────────────────────────────────────────────────────

export const sortNodes = (items: FileNode[]) =>
  items.slice().sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

export const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

export const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};

export const isDirectoryReadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('is a directory') || normalized.includes('eisdir');
};

export const isFileMissingError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('file not found')
    || normalized.includes('enoent')
    || normalized.includes('no such file')
    || normalized.includes('does not exist');
};

export const getFileIcon = (filePath: string, extension?: string): React.ReactNode => {
  return <FileTypeIcon filePath={filePath} extension={extension} />;
};

export const isMarkdownFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'md' || ext === 'markdown';
};

export const isJsonFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson';
};

export const isHtmlFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'html' || ext === 'htm';
};

// ── Line Ending Helpers ────────────────────────────────────────────────────────

export const detectFileLineEnding = (content: string): FileLineEnding => {
  let crlf = 0;
  let lf = 0;

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) {
      continue;
    }
    if (index > 0 && content.charCodeAt(index - 1) === 13) {
      crlf += 1;
    } else {
      lf += 1;
    }
  }

  return crlf > lf ? '\r\n' : '\n';
};

export const normalizeEditorLineEndings = (content: string): string => content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export const serializeEditorContent = (content: string, lineEnding: FileLineEnding): string => {
  const normalized = normalizeEditorLineEndings(content);
  return lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
};

export const getInitialAutoSaveEnabled = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    return window.localStorage.getItem(FILE_EDITOR_AUTO_SAVE_KEY) !== 'false';
  } catch {
    return true;
  }
};
